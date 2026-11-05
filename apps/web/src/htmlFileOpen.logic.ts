import { isMacPlatform } from "~/lib/utils";

/** Literal filesystem paths, as the desktop check and the file viewer's preview test them. */
export const isHtmlFilePath = (path: string): boolean => /\.html?$/i.test(path);

/**
 * Safari only when the desktop shell opens the file on a Mac. Other desktops hand it to the
 * system's default app for .html; a plain web client opens a new tab.
 */
export function systemBrowserLabel(input: {
  readonly platform: string;
  readonly hasDesktopOpen: boolean;
}): string {
  if (!input.hasDesktopOpen) return "New Tab";
  return isMacPlatform(input.platform) ? "Safari" : "Browser";
}

export class FileTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(
      `Files over ${Math.round(limitBytes / (1024 * 1024))} MB cannot be opened from another machine.`,
    );
  }
}

/** Streams the body and stops at `limitBytes`, since servers may omit Content-Length. */
export async function readResponseBytes(
  response: Response,
  limitBytes: number,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limitBytes) {
    await response.body?.cancel();
    throw new FileTooLargeError(limitBytes);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel();
      throw new FileTooLargeError(limitBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
