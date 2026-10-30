import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    /** Fresh recovery evidence for a Claude proxy failure with no native reset. */
    readonly poolResetAt: (baseUrl: string, model: string) => Effect.Effect<string | null>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

function hubOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function claudeModelIdentity(model: string) {
  const key = model
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/^claude-/, "")
    .replace(/[-. ]/g, "_")
    .replace(/_\d{8}$/, "");
  const match = /^([a-z]+)(?:_(\d+(?:_\d+)?))?$/.exec(key);
  return match ? { family: match[1], version: match[2] ?? null } : null;
}

function poolUsageLimitResetAt(
  accounts: ReadonlyArray<UsageLimitSourceAccount>,
  nowMs: number,
  model: string,
): string | null {
  const requestedModel = claudeModelIdentity(model);
  let earliest = Infinity;
  for (const account of accounts) {
    if (account.driver !== "claudeAgent") continue;
    if (account.usageLimits.unavailable) return null;
    let recovery = -Infinity;
    for (const window of account.usageLimits.windows) {
      if (window.usedPercent < 100) continue;
      if (window.id.startsWith("seven_day_")) {
        const scopedModel = claudeModelIdentity(window.id.slice("seven_day_".length));
        // Bare aliases and custom names do not identify which version the hub routes.
        if (!requestedModel?.version || scopedModel === null) return null;
        if (
          scopedModel.family !== requestedModel.family ||
          (scopedModel.version !== null && scopedModel.version !== requestedModel.version)
        )
          continue;
      }
      const reset = DateTime.make(window.resetsAt ?? "");
      if (Option.isNone(reset)) return null;
      const resetMs = DateTime.toEpochMillis(reset.value);
      if (resetMs <= nowMs) return null;
      recovery = Math.max(recovery, resetMs);
    }
    // One account with headroom makes the pool's outage unexplained.
    if (!Number.isFinite(recovery)) return null;
    earliest = Math.min(earliest, recovery);
  }
  return Number.isFinite(earliest) ? DateTime.formatIso(DateTime.makeUnsafe(earliest)) : null;
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    if (config.managementKey.length === 0) {
      return { ...base, accounts: [], error: "No management key configured." };
    }
    const accounts = yield* api.readAccounts(config).pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refreshSources = Effect.fn("UsageLimitSources.refreshSources")(
    function* (origin: string | undefined) {
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      const enabled = Object.entries(settings?.usageLimitSources ?? {}).filter(
        ([, config]) => config.enabled,
      );
      const entries = enabled.filter(
        ([, config]) => origin === undefined || hubOrigin(config.url) === origin,
      );
      if (origin !== undefined && entries.length === 0) return [];
      const snapshots = yield* Effect.forEach(
        entries,
        ([id, config]) => readSource(id as UsageLimitSourceId, config),
        { concurrency: 4 },
      );
      const byId = new Map(
        [...(yield* Ref.get(stateRef)), ...snapshots].map((source) => [source.id, source]),
      );
      yield* publish(
        enabled.flatMap(([id]) => {
          const snapshot = byId.get(id as UsageLimitSourceId);
          return snapshot ? [snapshot] : [];
        }),
      );
      return snapshots;
    },
    (effect) => effect.pipe(refreshLock.withPermits(1)),
  );

  const refresh = refreshSources(undefined).pipe(Effect.asVoid, Effect.ignoreCause({ log: true }));

  const poolResetAt = Effect.fn("UsageLimitSources.poolResetAt")(function* (
    baseUrl: string,
    model: string,
  ) {
    const origin = hubOrigin(baseUrl);
    if (origin === null) return null;
    // Never use cached windows after a failed or timed-out refresh: routing
    // and account availability may have changed since that snapshot.
    const snapshots = yield* refreshSources(origin).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => null),
    );
    if (snapshots === null || snapshots.some((source) => "error" in source)) return null;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    return poolUsageLimitResetAt(
      snapshots.flatMap((source) => source.accounts),
      nowMs,
      model,
    );
  });

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled || !config.managementKey) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const result = yield* api.consume(config, input.accountId, input.creditId);
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    refresh,
    poolResetAt,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);

/** For tests that build drivers but have no hub: reports no sources and never knows a pool reset. */
export const layerTest = Layer.succeed(UsageLimitSources, {
  current: Effect.succeed([]),
  streamChanges: Stream.make([]),
  refresh: Effect.void,
  poolResetAt: Effect.fn("UsageLimitSources.poolResetAt")(() => Effect.succeed(null)),
  consumeResetCredit: Effect.fn("UsageLimitSources.consumeResetCredit")(() =>
    Effect.fail(new UsageLimitSourceError({ detail: "No usage limit source in tests." })),
  ),
});
