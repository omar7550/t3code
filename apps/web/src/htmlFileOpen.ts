import {
  DESKTOP_OPEN_FILE_COPY_MAX_BYTES,
  type AssetResource,
  type DesktopOpenFileAction,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { workspaceAssetResource } from "~/components/files/filePreviewMode";
import { revealInFileExplorerLabel } from "~/components/preview/fileExplorerLabel";
import { toastManager } from "~/components/ui/toast";
import { useRemoteOpenState } from "~/remoteOpen";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { readResponseBytes, systemBrowserLabel } from "./htmlFileOpen.logic";

export interface HtmlFileTarget {
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  /** A draft has no thread yet, so the server signs the file against the workspace root. */
  readonly threadRef: ScopedThreadRef | null;
}

function htmlFileAssetResource(target: HtmlFileTarget): AssetResource {
  if (target.threadRef === null) {
    return { _tag: "draft-workspace-file", cwd: target.workspaceRoot, path: target.absolutePath };
  }
  return workspaceAssetResource({
    kind: "workspace-file",
    threadRef: target.threadRef,
    draft: false,
    workspaceRoot: target.workspaceRoot,
    absolutePath: target.absolutePath,
  });
}

async function readFileBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("The file could not be downloaded.");
  return readResponseBytes(response, DESKTOP_OPEN_FILE_COPY_MAX_BYTES);
}

/**
 * Opens an HTML file in the system browser or reveals it in the file manager on the machine
 * the user is clicking on. A file on another environment is copied into the desktop's cache
 * first, because its path does not exist here.
 */
export function useHtmlFileOpener(environmentId: EnvironmentId | null) {
  const remote = useRemoteOpenState(environmentId);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const desktopOpenFile = window.desktopBridge?.openFile;
  const browserLabel = systemBrowserLabel({
    platform: navigator.platform,
    hasDesktopOpen: desktopOpenFile !== undefined,
  });
  const canDownload = environmentId !== null && canReadFiles && httpBaseUrl !== null;

  const openWithDesktop = async (
    action: DesktopOpenFileAction,
    target: HtmlFileTarget,
  ): Promise<void> => {
    if (desktopOpenFile !== undefined && remote.mode === "local-exec") {
      const result = await desktopOpenFile({
        action,
        path: target.absolutePath,
        source: { _tag: "local" },
      });
      if (result === "opened") return;
      // WSL and other local-exec servers can report paths this machine does not have.
      if (result !== "missing") throw new Error("The system could not open the file.");
    }
    if (!canDownload || environmentId === null || httpBaseUrl === null) {
      throw new Error("This connection cannot read files on that environment.");
    }
    const minted = await createAssetUrl({
      environmentId,
      input: { resource: htmlFileAssetResource(target) },
    });
    if (minted._tag === "Failure")
      throw new Error("The file could not be read from the environment.");
    const url = resolveAssetUrl(httpBaseUrl, minted.value.relativeUrl);
    if (url === null) throw new Error("The environment returned an invalid file URL.");
    if (desktopOpenFile === undefined) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const bytes = await readFileBytes(url);
    const result = await desktopOpenFile({
      action,
      path: target.absolutePath,
      source: { _tag: "copy", environmentId, bytes },
    });
    if (result !== "opened") throw new Error("The system could not open the downloaded copy.");
  };

  const open = async (action: DesktopOpenFileAction, target: HtmlFileTarget): Promise<boolean> => {
    try {
      await openWithDesktop(action, target);
      return true;
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "reveal" ? "Unable to reveal file" : `Unable to open in ${browserLabel}`,
        description: cause instanceof Error ? cause.message : target.absolutePath,
      });
      return false;
    }
  };

  return {
    /** Web clients without the desktop shell open the file in a new browser tab instead. */
    canOpen: desktopOpenFile !== undefined ? environmentId !== null : canDownload,
    canReveal: desktopOpenFile !== undefined && environmentId !== null,
    browserLabel,
    revealLabel: revealInFileExplorerLabel(navigator.platform),
    open,
  };
}
