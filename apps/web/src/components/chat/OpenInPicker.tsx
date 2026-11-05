import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  type DesktopOpenFileAction,
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, use, useRef } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { OPEN_FAVORITE_EDITOR_ATTRIBUTE } from "./OpenInPickerShortcut";
import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
} from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import {
  ChevronDownIcon,
  FolderClosedIcon,
  Globe2Icon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";

import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  FileExplorerIcon,
  FinderIcon,
  Icon,
  KiroIcon,
  SafariIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { announce } from "~/lib/announce";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useComposerMenuState } from "./useComposerMenuState";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

const resolveOpenInOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<Omit<OpenInOption, "label">> = [
    {
      Icon: CursorIcon,
      value: "cursor",
      kind: "brand",
    },
    {
      Icon: TraeIcon,
      value: "trae",
      kind: "brand",
    },
    {
      Icon: KiroIcon,
      value: "kiro",
      kind: "brand",
    },
    {
      Icon: VisualStudioCode,
      value: "vscode",
      kind: "brand",
    },
    {
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
      kind: "brand",
    },
    {
      Icon: VSCodium,
      value: "vscodium",
      kind: "brand",
    },
    {
      Icon: Zed,
      value: "zed",
      kind: "brand",
    },
    {
      Icon: AntigravityIcon,
      value: "antigravity",
      kind: "brand",
    },
    {
      Icon: IntelliJIdeaIcon,
      value: "idea",
      kind: "brand",
    },
    {
      Icon: AquaIcon,
      value: "aqua",
      kind: "brand",
    },
    {
      Icon: CLionIcon,
      value: "clion",
      kind: "brand",
    },
    {
      Icon: DataGripIcon,
      value: "datagrip",
      kind: "brand",
    },
    {
      Icon: DataSpellIcon,
      value: "dataspell",
      kind: "brand",
    },
    {
      Icon: GoLandIcon,
      value: "goland",
      kind: "brand",
    },
    {
      Icon: PhpStormIcon,
      value: "phpstorm",
      kind: "brand",
    },
    {
      Icon: PyCharmIcon,
      value: "pycharm",
      kind: "brand",
    },
    {
      Icon: RiderIcon,
      value: "rider",
      kind: "brand",
    },
    {
      Icon: RubyMineIcon,
      value: "rubymine",
      kind: "brand",
    },
    {
      Icon: RustRoverIcon,
      value: "rustrover",
      kind: "brand",
    },
    {
      Icon: WebStormIcon,
      value: "webstorm",
      kind: "brand",
    },
    {
      Icon: isMacPlatform(platform)
        ? FinderIcon
        : isWindowsPlatform(platform)
          ? FileExplorerIcon
          : FolderClosedIcon,
      value: "file-manager",
      kind: isMacPlatform(platform) || isWindowsPlatform(platform) ? "brand" : "generic",
    },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({ ...option, label: editorLabelForPlatform(option.value, platform) }));
};

/** HTML files open in the system browser by default; editors move into the menu. */
export interface OpenInPickerHtmlFile {
  readonly browserLabel: string;
  readonly revealLabel: string;
  readonly canReveal: boolean;
  readonly open: (action: DesktopOpenFileAction) => Promise<boolean>;
}

function systemBrowserIcon(platform: string): { Icon: Icon; kind: OpenInOption["kind"] } {
  return isMacPlatform(platform)
    ? { Icon: SafariIcon, kind: "brand" }
    : { Icon: Globe2Icon, kind: "generic" };
}

function fileManagerIcon(platform: string): { Icon: Icon; kind: OpenInOption["kind"] } {
  if (isMacPlatform(platform)) return { Icon: FinderIcon, kind: "brand" };
  if (isWindowsPlatform(platform)) return { Icon: FileExplorerIcon, kind: "brand" };
  return { Icon: FolderClosedIcon, kind: "generic" };
}

function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  openInCwdIsFile = false,
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
  displayMode = "toolbar",
  revealFileManager = false,
  htmlFile,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  openInCwdIsFile?: boolean;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
  displayMode?: "toolbar" | "panel";
  revealFileManager?: boolean;
  htmlFile?: OpenInPickerHtmlFile | undefined;
}) {
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const isHostEditorDenied = remote.mode === "local-exec" && !canOperateHost;
  const canOpenEditor = remote.mode !== "remote-unavailable" && !isHostEditorDenied;
  const [menuOpen, setMenuOpen] = useComposerMenuState(isHostEditorDenied);
  const remoteCapableEditors = useRemoteCapableEditors();
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  const environmentLabel = useEnvironment(environmentId)?.label ?? "this machine";
  // Remote editors run on the viewing machine; only desktop can probe that PATH.
  const effectiveEditors = remote.mode === "local-exec" ? availableEditors : remoteCapableEditors;
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);

  const openInEditor = async (editorId: EditorId | null): Promise<boolean> => {
    if (!openInCwd) return false;
    const editor = editorId ?? preferredEditor;
    if (!editor) return false;
    if (remote.mode === "remote-unavailable") return false;
    if (remote.mode === "remote-links") {
      const url = buildRemoteOpenUrl({
        editor,
        ...remote.host,
        absolutePath: openInCwd,
        isFile: openInCwdIsFile,
      });
      if (url === undefined) return false;
      // Only record hint-seen/preferred when the shell actually accepted
      // the URL (an older desktop build can refuse the editor scheme).
      const opened = await openRemoteEditorUrl(url);
      if (!opened) return false;
      markRemoteHintSeen();
      setPreferredEditor(editor);
      return true;
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
    const result = openInEditorMutation({
      environmentId,
      input: {
        cwd: openInCwd,
        editor,
        ...(revealFileManager && editor === "file-manager" ? { reveal: true } : {}),
      },
    });
    setPreferredEditor(editor);
    return (await result)._tag === "Success";
  };

  const openFavoriteEditorShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "editor.openFavorite",
  );

  const backgroundThread = use(BackgroundThreadContext);
  const options = resolveOpenInOptions(navigator.platform, effectiveEditors);
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const primaryLabel = isPanel ? `Open in ${primaryOption?.label ?? "editor"}` : "Open";

  const editorItems = (
    <>
      {remote.mode === "remote-unavailable" ? (
        <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
          No SSH route to {environmentLabel}
        </MenuItem>
      ) : (
        <>
          {options.length === 0 && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              No installed editors found
            </MenuItem>
          )}
          {(htmlFile?.canReveal
            ? options.filter(({ value }) => value !== "file-manager")
            : options
          ).map(({ label, Icon, value, kind }) => (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              disabled={!openInCwd || !canOpenEditor}
              key={value}
              onClick={() => {
                if (presentation === "menu" || htmlFile) {
                  void openInEditor(value);
                } else {
                  setPreferredEditor(value);
                }
              }}
            >
              <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
              <MenuItemLabel>{label}</MenuItemLabel>
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          {remote.mode === "remote-links" && !remoteHintSeen && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              Opens over SSH. Needs your key on {environmentLabel}
            </MenuItem>
          )}
        </>
      )}
    </>
  );
  if (presentation === "menu") {
    return (
      <>
        {primaryOption && (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}

            disabled={!openInCwd || !canOpenEditor}
            onClick={() => openInEditor(preferredEditor)}
          >
            <primaryOption.Icon className={cn("size-4", getOpenInIconClass(primaryOption.kind))} />
            <MenuItemLabel>Open in {primaryOption.label}</MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub>
          <MenuSubTrigger density="touch" disabled={isHostEditorDenied}>
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>Open in…</MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
      </>
    );
  }

  const browserIcon = systemBrowserIcon(navigator.platform);
  const managerIcon = fileManagerIcon(navigator.platform);
  const openHtmlFile = (action: DesktopOpenFileAction) => {
    if (!htmlFile) return;
    void htmlFile.open(action).then((opened) => {
      if (!opened) return;
      announce(action === "reveal" ? htmlFile.revealLabel : `Opened in ${htmlFile.browserLabel}`);
    });
  };
  const menuContent = htmlFile ? (
    <>
      <MenuItem onClick={() => openHtmlFile("browser")}>
        <browserIcon.Icon aria-hidden="true" className={getOpenInIconClass(browserIcon.kind)} />
        <MenuItemLabel>{htmlFile.browserLabel}</MenuItemLabel>
        {openFavoriteEditorShortcutLabel && (
          <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
        )}
      </MenuItem>
      {htmlFile.canReveal && (
        <MenuItem onClick={() => openHtmlFile("reveal")}>
          <managerIcon.Icon aria-hidden="true" className={getOpenInIconClass(managerIcon.kind)} />
          <MenuItemLabel>{htmlFile.revealLabel}</MenuItemLabel>
        </MenuItem>
      )}
      <MenuSeparator />
      {editorItems}
    </>
  ) : (
    editorItems
  );
  const PrimaryIcon = htmlFile ? browserIcon.Icon : primaryOption?.Icon;
  const primaryIconKind = htmlFile ? browserIcon.kind : primaryOption?.kind;
  const primaryText = htmlFile ? `Open in ${htmlFile.browserLabel}` : primaryLabel;

  return (
    <ActionGroup
      aria-label="Open in editor"
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : {})}
    >
      <ThreadDetailsControl
        aria-label={
          htmlFile ? primaryText : compact ? "Open file in preferred editor" : primaryLabel
        }
        size={isPanel ? "sm" : "xs"}
        variant={isPanel ? "ghost" : "outline"}
        part="primary"
        panel={isPanel}
        disabled={htmlFile ? false : !preferredEditor || !openInCwd || !canOpenEditor}
        {...(enableShortcut && !backgroundThread ? { [OPEN_FAVORITE_EDITOR_ATTRIBUTE]: "" } : {})}
        onClick={() => {
          if (htmlFile) {
            openHtmlFile("browser");
            return;
          }
          if (!preferredEditor) return;
          const label = editorLabelForPlatform(preferredEditor, navigator.platform);
          void openInEditor(preferredEditor).then((opened) => {
            if (opened) announce(`Opened in ${label}`);
          });
        }}
      >
        {PrimaryIcon && primaryIconKind ? (
          <PrimaryIcon
            aria-hidden="true"
            className={cn(
              isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5",
              getOpenInIconClass(primaryIconKind),
            )}
          />
        ) : isPanel ? (
          <SquareArrowOutUpRightIcon
            aria-hidden="true"
            className={THREAD_DETAILS_PANEL_ICON_CLASS}
          />
        ) : null}
        <span
          className={cn(
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
            isPanel && cn("not-sr-only ml-0 min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
          )}
        >
          {primaryText}
        </span>
      </ThreadDetailsControl>
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : (
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      )}
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          disabled={isHostEditorDenied && !htmlFile}
          render={
            <ThreadDetailsControl
              aria-label={htmlFile ? "More ways to open" : "Choose editor"}
              size={isPanel ? "sm" : "icon-xs"}
              variant={isPanel ? "ghost" : "outline"}
              part="secondary"
              panel={isPanel}
            />
          }
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
          />
        </MenuTrigger>
        <MenuPopup
          align="end"
          {...(isPanel ? { anchor: panelAnchorRef } : {})}
          className={isPanel ? "w-(--anchor-width)" : undefined}
        >
          {menuContent}
        </MenuPopup>
      </Menu>
    </ActionGroup>
  );
});
