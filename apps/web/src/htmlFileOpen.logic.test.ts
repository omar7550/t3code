import { describe, expect, it } from "vite-plus/test";

import {
  FileTooLargeError,
  isHtmlFilePath,
  readResponseBytes,
  systemBrowserLabel,
} from "./htmlFileOpen.logic";

describe("systemBrowserLabel", () => {
  it("names Safari only when the Mac desktop shell opens the file", () => {
    expect(systemBrowserLabel({ platform: "MacIntel", hasDesktopOpen: true })).toBe("Safari");
    expect(systemBrowserLabel({ platform: "MacIntel", hasDesktopOpen: false })).toBe("New Tab");
    expect(systemBrowserLabel({ platform: "Linux x86_64", hasDesktopOpen: true })).toBe("Browser");
    expect(systemBrowserLabel({ platform: "Win32", hasDesktopOpen: false })).toBe("New Tab");
  });
});

it("treats literal .html and .htm paths as HTML, not .xhtml", () => {
  expect(isHtmlFilePath("/site/index.HTML")).toBe(true);
  expect(isHtmlFilePath("/site/a.htm")).toBe(true);
  expect(isHtmlFilePath("/site/a.xhtml")).toBe(false);
  // `#` and `?` are part of the file name, matching what the desktop accepts.
  expect(isHtmlFilePath("/site/a#b.html")).toBe(true);
  expect(isHtmlFilePath("/site/a.html#x")).toBe(false);
});

describe("readResponseBytes", () => {
  const chunkedResponse = (chunks: ReadonlyArray<Uint8Array>) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[0];
        if (next === undefined) return controller.close();
        chunks = chunks.slice(1);
        controller.enqueue(next);
      },
      cancel() {
        cancelled = true;
      },
    });
    return { response: new Response(body), wasCancelled: () => cancelled };
  };

  it("joins the chunks of a body under the limit", async () => {
    const { response } = chunkedResponse([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect([...(await readResponseBytes(response, 3))]).toEqual([1, 2, 3]);
  });

  it("aborts mid-stream past the limit when Content-Length is missing", async () => {
    const { response, wasCancelled } = chunkedResponse([
      new Uint8Array(3),
      new Uint8Array(3),
      new Uint8Array(3),
    ]);
    await expect(readResponseBytes(response, 4)).rejects.toBeInstanceOf(FileTooLargeError);
    expect(wasCancelled()).toBe(true);
  });

  it("refuses up front when Content-Length is over the limit", async () => {
    const response = new Response("too long", { headers: { "content-length": "8" } });
    await expect(readResponseBytes(response, 4)).rejects.toBeInstanceOf(FileTooLargeError);
  });
});
