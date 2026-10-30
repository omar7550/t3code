import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

const ONE_HOUR = "2026-10-10T01:00:00.000Z";
const TWO_HOURS = "2026-10-10T02:00:00.000Z";
const ONE_DAY = "2026-10-11T00:00:00.000Z";
const decodeAccountRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ auth_index: Schema.String })),
);

type HubAccount = {
  id: string;
  five_hour: { utilization: number; resets_at: string | null };
  seven_day?: { utilization: number; resets_at: string | null };
  limits?: Array<{
    kind: "weekly_scoped";
    percent: number;
    resets_at: string;
    scope: { model: { display_name: string } };
  }>;
};

const makePoolFixture = (hubs: Record<string, Array<HubAccount>>) => {
  const reads: Array<string> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const sourceUrl = request.url.split("v0/management/")[0]!;
      const accounts = hubs[sourceUrl];
      expect(accounts).toBeDefined();
      if (request.url.endsWith("/auth-files")) {
        reads.push(sourceUrl);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            files: accounts!.map(({ id }) => ({ id, auth_index: id, provider: "claude" })),
          }),
        );
      }
      expect(request.url).toMatch(/\/api-call$/);
      if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request body.");
      const { auth_index } = decodeAccountRequest(new TextDecoder().decode(request.body.body));
      const account = accounts!.find(({ id }) => id === auth_index);
      expect(account).toBeDefined();
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: 200, body: JSON.stringify(account) }),
      );
    }),
  );
  const layer = UsageLimitSources.layer.pipe(
    Layer.provide([
      ServerSettings.layerTest({
        usageLimitSources: Object.fromEntries(
          Object.keys(hubs).map((url, index) => [
            UsageLimitSourceId.make("hub-" + index),
            { kind: "cliproxy", url, managementKey: "test-secret", enabled: true },
          ]),
        ),
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(HttpClient.HttpClient, http),
      NodeCrypto.layer,
    ]),
  );
  return { layer, reads };
};

describe("UsageLimitSources.poolResetAt", () => {
  it.effect("refreshes only the matching hub and waits until one whole account recovers", () => {
    const accounts: Array<HubAccount> = [
      { id: "a", five_hour: { utilization: 100, resets_at: ONE_DAY } },
      {
        id: "b",
        five_hour: { utilization: 100, resets_at: ONE_HOUR },
        seven_day: { utilization: 100, resets_at: ONE_DAY },
      },
    ];
    const test = makePoolFixture({
      "https://hub.test:8317/": accounts,
      "https://unrelated.test/": [],
    });
    return TestClock.setTime(Date.parse("2026-10-10T00:00:00.000Z")).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const sources = yield* UsageLimitSources.UsageLimitSources;
          yield* sources.refresh;
          test.reads.length = 0;
          accounts[0]!.five_hour.resets_at = TWO_HOURS;
          expect(yield* sources.poolResetAt("https://hub.test:8317/v1/", "claude-fable-5-1")).toBe(
            TWO_HOURS,
          );
          expect(test.reads).toEqual(["https://hub.test:8317/"]);
          accounts[1]!.five_hour.resets_at = "2026-10-09T23:00:00.000Z";
          expect(
            yield* sources.poolResetAt("https://hub.test:8317/v1/", "claude-fable-5-1"),
          ).toBeNull();
        }).pipe(Effect.provide(test.layer)),
      ),
    );
  });

  it.effect("does not predict an outage when another same-origin source has headroom", () => {
    const test = makePoolFixture({
      "https://hub.test:8317/": [
        { id: "limited", five_hour: { utilization: 100, resets_at: ONE_HOUR } },
      ],
      "https://hub.test:8317/other-view/": [
        { id: "available", five_hour: { utilization: 20, resets_at: ONE_DAY } },
      ],
    });
    return TestClock.setTime(Date.parse("2026-10-10T00:00:00.000Z")).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const sources = yield* UsageLimitSources.UsageLimitSources;
          yield* sources.refresh;
          expect(
            yield* sources.poolResetAt("https://hub.test:8317/v1", "claude-fable-5-1"),
          ).toBeNull();
        }).pipe(Effect.provide(test.layer)),
      ),
    );
  });

  it.effect("waits for the requested model's windows without waiting for another model", () => {
    const limits: NonNullable<HubAccount["limits"]> = [
      {
        kind: "weekly_scoped",
        percent: 100,
        resets_at: ONE_DAY,
        scope: { model: { display_name: "Fable" } },
      },
    ];
    const test = makePoolFixture({
      "https://hub.test:8317/": [
        {
          id: "limited",
          five_hour: { utilization: 100, resets_at: ONE_HOUR },
          limits,
        },
      ],
    });
    return TestClock.setTime(Date.parse("2026-10-10T00:00:00.000Z")).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const sources = yield* UsageLimitSources.UsageLimitSources;
          yield* sources.refresh;
          expect(yield* sources.poolResetAt("https://hub.test:8317/v1", "claude-fable-5-1")).toBe(
            ONE_DAY,
          );
          expect(yield* sources.poolResetAt("https://hub.test:8317/v1", "claude-opus-5-5")).toBe(
            ONE_HOUR,
          );
          expect(
            yield* sources.poolResetAt("https://hub.test:8317/v1", "claude-fable-5-1[1m]"),
          ).toBe(ONE_DAY);
          expect(yield* sources.poolResetAt("https://hub.test:8317/v1", "fable")).toBeNull();
          limits[0]!.scope.model.display_name = "Fable 5.1";
          expect(yield* sources.poolResetAt("https://hub.test:8317/v1", "claude-fable-5-2")).toBe(
            ONE_HOUR,
          );
          expect(
            yield* sources.poolResetAt("https://hub.test:8317/v1", "claude-fable-5-1-20261001[1m]"),
          ).toBe(ONE_DAY);
        }).pipe(Effect.provide(test.layer)),
      ),
    );
  });
});
