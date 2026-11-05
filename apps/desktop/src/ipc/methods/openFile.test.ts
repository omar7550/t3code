// @effect-diagnostics nodeBuiltinImport:off -- The helpers take a plain join, so tests use Node's.
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ shell: {} }));

import { isOpenFileRequestAllowed, openFileCachePath, openFileCacheRoot } from "./openFile.ts";

const join = NodePath.posix.join;

describe("openFileCacheRoot", () => {
  it.each([
    {
      platform: "darwin" as const,
      env: {},
      expected: "/Users/me/Library/Caches/T3 Code (Nightly)/remote-open",
    },
    {
      platform: "linux" as const,
      env: { XDG_CACHE_HOME: "/xdg" },
      expected: "/xdg/T3 Code (Nightly)/remote-open",
    },
    {
      platform: "linux" as const,
      env: {},
      expected: "/Users/me/.cache/T3 Code (Nightly)/remote-open",
    },
  ])("uses the $platform cache folder", ({ platform, env, expected }) => {
    expect(
      openFileCacheRoot({
        platform,
        homeDirectory: "/Users/me",
        appDataDirectory: "/Users/me/AppData",
        displayName: "T3 Code (Nightly)",
        env,
        join,
      }),
    ).toBe(expected);
  });
});

describe("openFileCachePath", () => {
  const cachePath = (environmentId: string, remotePath: string) =>
    openFileCachePath({ cacheRoot: "/cache", environmentId, remotePath, join });

  it("mirrors the remote path below the environment", () => {
    expect(cachePath("env-1", "/home/omar/dev/report.html")).toBe(
      "/cache/env-1/home/omar/dev/report.html",
    );
    expect(cachePath("env-1", "C:\\Users\\me\\a.htm")).toBe("/cache/env-1/C_/Users/me/a.htm");
  });

  it("refuses paths that could leave the cache", () => {
    expect(cachePath("env-1", "/home/../../etc/passwd")).toBeNull();
    expect(cachePath("..", "/home/a.html")).toBeNull();
    expect(cachePath("env-1", "/")).toBeNull();
  });
});

describe("isOpenFileRequestAllowed", () => {
  const allowed = (path: string, source: "local" | "copy") =>
    isOpenFileRequestAllowed({ path, source, isAbsolute: NodePath.posix.isAbsolute });

  it("accepts absolute local HTML and copied HTML", () => {
    expect(allowed("/a/index.HTML", "local")).toBe(true);
    expect(allowed("/a/page.htm", "copy")).toBe(true);
  });

  it("refuses other file types for both sources, so nothing runnable lands in the cache", () => {
    for (const path of ["/a/run.command", "/a/x.terminal", "/a/site.webloc", "/a/page.xhtml"]) {
      expect(allowed(path, "copy"), path).toBe(false);
      expect(allowed(path, "local"), path).toBe(false);
    }
  });

  it("refuses relative local paths, including ones that look like options", () => {
    expect(allowed("page.html", "local")).toBe(false);
    expect(allowed("-a.html", "local")).toBe(false);
  });
});
