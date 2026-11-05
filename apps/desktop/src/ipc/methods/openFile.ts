// @effect-diagnostics nodeBuiltinImport:off -- This boundary hands a file to macOS `open -a Safari`, which has no Effect wrapper here.
import {
  DESKTOP_OPEN_FILE_COPY_MAX_BYTES,
  DesktopOpenFileInputSchema,
  DesktopOpenFileResultSchema,
  type DesktopOpenFileAction,
  type DesktopOpenFileResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Electron from "electron";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const BROWSER_FILE_PATTERN = /\.html?$/i;
// Characters Windows rejects in file names, plus control characters.
const UNSAFE_SEGMENT_CHARACTERS = /[<>:"|?*\u0000-\u001f]/g;

/** Per-platform cache folder that holds local copies of files from other environments. */
export function openFileCacheRoot(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly appDataDirectory: string;
  readonly displayName: string;
  readonly env: NodeJS.ProcessEnv;
  readonly join: (...segments: string[]) => string;
}): string {
  const { join } = input;
  if (input.platform === "darwin") {
    return join(input.homeDirectory, "Library", "Caches", input.displayName, "remote-open");
  }
  if (input.platform === "win32") {
    const base = input.env.LOCALAPPDATA?.trim() || input.appDataDirectory;
    return join(base, input.displayName, "Cache", "remote-open");
  }
  const base = input.env.XDG_CACHE_HOME?.trim() || join(input.homeDirectory, ".cache");
  return join(base, input.displayName, "remote-open");
}

function safeSegment(segment: string): string | null {
  const cleaned = segment.replace(UNSAFE_SEGMENT_CHARACTERS, "_").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return null;
  return cleaned;
}

/**
 * Mirrors the remote path below `<cacheRoot>/<environment>` so the copy keeps its file name and
 * repeated opens of one file overwrite one copy. Returns null for paths that could escape it.
 */
export function openFileCachePath(input: {
  readonly cacheRoot: string;
  readonly environmentId: string;
  readonly remotePath: string;
  readonly join: (...segments: string[]) => string;
}): string | null {
  const environment = safeSegment(input.environmentId);
  if (environment === null) return null;
  const rawSegments = input.remotePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (rawSegments.length === 0) return null;
  const segments: string[] = [];
  for (const raw of rawSegments) {
    if (raw === "." || raw === "..") return null;
    const segment = safeSegment(raw);
    if (segment === null) return null;
    segments.push(segment);
  }
  return input.join(input.cacheRoot, environment, ...segments);
}

/**
 * Only HTML documents pass, for either action: the copy source writes renderer-supplied bytes
 * to disk, and a revealed `.command` or `.webloc` there would run on a double-click in Finder.
 * Local paths must be absolute, which also keeps a leading `-` away from `open`'s options.
 */
export function isOpenFileRequestAllowed(input: {
  readonly path: string;
  readonly source: "local" | "copy";
  readonly isAbsolute: (path: string) => boolean;
}): boolean {
  if (!BROWSER_FILE_PATTERN.test(input.path)) return false;
  return input.source === "copy" || input.isAbsolute(input.path);
}

const openExternalFile = (filePath: string) =>
  Effect.promise(() =>
    Electron.shell.openExternal(NodeURL.pathToFileURL(filePath).href).then(
      () => true,
      () => false,
    ),
  );

// Safari is the default on macOS; when it cannot launch, the system's handler for the file wins.
const openInSafari = (filePath: string) =>
  Effect.callback<boolean>((resume) => {
    if (filePath.startsWith("-")) {
      resume(Effect.succeed(false));
      return;
    }
    NodeChildProcess.execFile("open", ["-a", "Safari", filePath], (error) => {
      resume(error === null ? Effect.succeed(true) : openExternalFile(filePath));
    });
  });

const launch = (action: DesktopOpenFileAction, platform: NodeJS.Platform, filePath: string) => {
  if (action === "reveal") {
    return Effect.sync(() => {
      Electron.shell.showItemInFolder(filePath);
      return true;
    });
  }
  // Elsewhere this is the system's default app for .html, which is normally the default browser.
  return platform === "darwin" ? openInSafari(filePath) : openExternalFile(filePath);
};

export const openFile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_FILE_CHANNEL,
  payload: DesktopOpenFileInputSchema,
  result: DesktopOpenFileResultSchema,
  handler: Effect.fn("desktop.ipc.openFile")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (
      !isOpenFileRequestAllowed({
        path: input.path,
        source: input.source._tag,
        isAbsolute: path.isAbsolute,
      })
    ) {
      return "failed" satisfies DesktopOpenFileResult;
    }

    if (input.source._tag === "local") {
      const info = yield* fileSystem.stat(input.path).pipe(Effect.option);
      if (info._tag === "None" || info.value.type !== "File") {
        return "missing" satisfies DesktopOpenFileResult;
      }
      const opened = yield* launch(input.action, environment.platform, input.path);
      return opened ? "opened" : "failed";
    }

    if (input.source.bytes.byteLength > DESKTOP_OPEN_FILE_COPY_MAX_BYTES) {
      return "failed" satisfies DesktopOpenFileResult;
    }
    const cacheRoot = openFileCacheRoot({
      platform: environment.platform,
      homeDirectory: environment.homeDirectory,
      appDataDirectory: environment.appDataDirectory,
      displayName: environment.displayName,
      env: yield* HostProcess.Environment,
      join: path.join,
    });
    const target = openFileCachePath({
      cacheRoot,
      environmentId: input.source.environmentId,
      remotePath: input.path,
      join: path.join,
    });
    if (target === null) return "failed" satisfies DesktopOpenFileResult;
    const bytes = input.source.bytes;
    // Write beside the target and rename, so Safari never reads a half-written copy.
    const written = yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${yield* Clock.currentTimeMillis}.partial`;
      yield* fileSystem.writeFile(temporary, bytes);
      yield* fileSystem
        .rename(temporary, target)
        .pipe(Effect.tapError(() => fileSystem.remove(temporary).pipe(Effect.ignore)));
    }).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("Could not write the local copy of a remote file", cause).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (!written) return "failed" satisfies DesktopOpenFileResult;
    const opened = yield* launch(input.action, environment.platform, target);
    return opened ? "opened" : "failed";
  }),
});
