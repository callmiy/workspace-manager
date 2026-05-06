import * as OpenTuiCore from "@opentui/core";
import * as OpenTuiReact from "@opentui/react";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UserConfig, WorkspaceRef } from "../domain/types.js";
import { defaultConfig, ensureConfigDir, loadConfig, resolveConfigPath } from "../config/config.js";
import { discoverWorkspaces } from "../io/discovery.js";
import { buildShellEnvPrefixedCommand, resolveExportedEnvironment } from "../io/env-export.js";
import {
  applyMcpMutation,
  buildMcpMutationPreview,
  computeVendorTemplateDiffs,
  listMcpTemplates,
  loadMcpVendorConfigs,
  type McpMutationAction,
  type McpTemplateDoc,
  type McpVendorConfig,
  type McpVendorName,
} from "../io/mcp.js";
import { loadWorkspace, resolveWorkspaceTarget, writeWorkspaceFolders } from "../io/workspace.js";

type WorkspaceTab = "roots" | "associate" | "save";
type FeatureName = "workspace-manager" | "mcp";
type FocusZone = "rail" | "content";
type MessageTone = "info" | "success" | "error";

type KeyboardEventLike = {
  name: string;
  ctrl: boolean;
  sequence: string;
};

type SaveResult = {
  targetPath: string;
  folderCount: number;
};

type FolderObject = Record<string, unknown>;
type WorkspaceWriteEntry = { name: string; path: string; metadata: Record<string, unknown> };

type ConfirmationState = {
  title: string;
  lines: string[];
  confirmLabel: string;
  onConfirm: () => Promise<void>;
};

const createCliRenderer = (
  OpenTuiCore as unknown as { createCliRenderer: (options?: Record<string, unknown>) => Promise<unknown> }
).createCliRenderer;
const createRoot = (
  OpenTuiReact as unknown as {
    createRoot: (renderer: unknown) => { render: (node: unknown) => void; unmount: () => void };
  }
).createRoot;
const useKeyboard = (
  OpenTuiReact as unknown as { useKeyboard: (handler: (key: KeyboardEventLike) => void) => void }
).useKeyboard;

const KEYMAP_TEXT_FG = "#7dd3fc";
const KEYMAP_DELIMITER_FG = "#64748b";
const ROW_ACTIVE_BG = "#1d4ed8";
const ROW_ACTIVE_FG = "#f8fafc";
const ROW_SELECTED_BG = "#166534";
const ROW_SELECTED_ACTIVE_BG = "#15803d";
const TAB_ACTIVE_FG = "#fde68a";
const BORDER_FG = "#475569";
const RAIL_ACTIVE_BG = "#0f172a";
const WARNING_FG = "#f59e0b";
const ERROR_FG = "#f87171";
const SUCCESS_FG = "#4ade80";
const MUTED_FG = "#94a3b8";

const FEATURE_ITEMS: Array<{ id: FeatureName; label: string; index: string }> = [
  { id: "workspace-manager", label: "workspace-manager", index: "1" },
  { id: "mcp", label: "mcp", index: "2" },
];

const MCP_ACTIONS: McpMutationAction[] = ["add", "update", "remove"];
const MCP_VENDOR_SCOPE_OPTIONS = ["selected", "all"] as const;
const MCP_TEMPLATE_SCOPE_OPTIONS = ["selected", "all"] as const;

function linePrefix(active: boolean): string {
  return active ? ">" : " ";
}

function isPrintableKey(sequence: string): boolean {
  return sequence.length === 1 && sequence >= " " && sequence <= "~";
}

function isQuestionKey(key: KeyboardEventLike): boolean {
  return key.name === "?" || key.sequence === "?";
}

function fuzzyScore(candidate: string, query: string): number | null {
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) {
    return 0;
  }

  let needleIndex = 0;
  let score = 0;
  let lastMatchIndex = -1;

  for (let i = 0; i < haystack.length && needleIndex < needle.length; i += 1) {
    if (haystack[i] === needle[needleIndex]) {
      score += lastMatchIndex + 1 === i ? 3 : 1;
      lastMatchIndex = i;
      needleIndex += 1;
    }
  }

  if (needleIndex !== needle.length) {
    return null;
  }

  if (haystack.includes(needle)) {
    score += 8;
  }

  return score - haystack.length / 10000;
}

function workspaceLabel(workspace: WorkspaceRef): string {
  return `${workspace.name}: ${workspace.path} [${workspace.existsOnDisk ? "exists" : "missing"}]`;
}

function getTerminalColumns(): number {
  return process.stdout.columns ?? 120;
}

function getTerminalRows(): number {
  return process.stdout.rows ?? 40;
}

function clampLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (text.length <= maxWidth) {
    return text;
  }
  if (maxWidth === 1) {
    return text.slice(0, 1);
  }
  return `${text.slice(0, maxWidth - 1)}…`;
}

function fitLine(text: string, maxWidth: number): string {
  return clampLine(text, maxWidth).padEnd(Math.max(0, maxWidth), " ");
}

function clampVisibleRowCount(value: number): number {
  return Math.max(1, value);
}

function estimateWrappedLineCount(lines: string[], maxWidth: number): number {
  if (maxWidth <= 0 || lines.length === 0) {
    return 0;
  }

  const combined = lines.join(" | ");
  return Math.max(1, Math.ceil(Math.max(1, combined.length) / maxWidth));
}

function getVisibleWindowBounds(total: number, selectedIndex: number, maxVisibleRows: number): { start: number; end: number } {
  if (total <= 0) {
    return { start: 0, end: 0 };
  }

  const visibleRows = Math.min(total, clampVisibleRowCount(maxVisibleRows));
  const safeSelectedIndex = Math.min(Math.max(selectedIndex, 0), total - 1);
  const centeredStart = safeSelectedIndex - Math.floor(visibleRows / 2);
  const start = Math.min(Math.max(0, centeredStart), Math.max(0, total - visibleRows));
  return {
    start,
    end: start + visibleRows,
  };
}

function findWorkspaceIndexByPath(workspaces: WorkspaceRef[], workspacePath: string | null): number {
  if (!workspacePath) {
    return 0;
  }

  const index = workspaces.findIndex((workspace) => workspace.path === workspacePath);
  return index >= 0 ? index : 0;
}

function lowerCaseWorkspaceFilename(name: string): string {
  return `${name.toLowerCase()}.code-workspace`;
}

function parseCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (!quote) {
        quote = char;
        continue;
      }
      if (quote === char) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) {
    return null;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens.length > 0 ? tokens : null;
}

function launchBinary(
  binary: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ReturnType<typeof spawnSync> {
  return spawnSync(binary, args, {
    stdio: "inherit",
    shell: false,
    cwd: options?.cwd,
    env: options?.env,
  });
}

function launchShellCommand(command: string, options?: { cwd?: string }): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-c", command], {
    stdio: "inherit",
    shell: false,
    cwd: options?.cwd,
    env: process.env,
  });
}

function launchEditorWithFile(editorCommand: string, filePath: string): ReturnType<typeof spawnSync> | null {
  const parsed = parseCommand(editorCommand);
  if (!parsed) {
    return null;
  }
  const [binary, ...args] = parsed;
  if (!binary) {
    return null;
  }

  const editorBasename = path.basename(binary).toLowerCase();
  const nvimServer = process.env.NVIM?.trim();
  const isNeovimFamilyEditor =
    editorBasename === "nvim" || editorBasename.startsWith("nvim-") || editorBasename === "vim" || editorBasename === "vi";

  if (nvimServer && isNeovimFamilyEditor) {
    return launchBinary("nvim", ["--server", nvimServer, "--remote", filePath]);
  }

  return launchBinary(binary, [...args, filePath]);
}

function buildFolderObjects(root: WorkspaceRef, associates: WorkspaceRef[]): Record<string, unknown>[] {
  return [root, ...associates].map((workspace) => ({
    name: workspace.name,
    path: workspace.path,
    ...workspace.metadata,
  }));
}

function toWorkspaceWriteEntries(folders: FolderObject[]): WorkspaceWriteEntry[] {
  return folders.map((entry) => {
    const { name, path: folderPath, ...metadata } = entry;
    return {
      name: String(name),
      path: String(folderPath),
      metadata,
    };
  });
}

function buildPreselectedAssociatePaths(root: WorkspaceRef, candidates: WorkspaceRef[], folderPaths: string[]): Set<string> {
  const preselected = new Set<string>();
  const seenGroups = new Set<string>();
  const folderPathSet = new Set(folderPaths);

  candidates.forEach((candidate) => {
    if (candidate.path === root.path || seenGroups.has(candidate.group) || !folderPathSet.has(candidate.path)) {
      return;
    }

    preselected.add(candidate.path);
    seenGroups.add(candidate.group);
  });

  return preselected;
}

function applyDetectedVirtualEnv(rootPath: string, envVars: Record<string, string>): Record<string, string> {
  const virtualEnvPath = path.join(rootPath, ".venv");
  const pythonPath = path.join(virtualEnvPath, "bin", "python");
  if (!existsSync(pythonPath)) {
    return envVars;
  }

  const currentPath = envVars.PATH ?? process.env.PATH ?? "";
  return {
    ...envVars,
    VIRTUAL_ENV: virtualEnvPath,
    PATH: `${path.join(virtualEnvPath, "bin")}${currentPath ? `:${currentPath}` : ""}`,
  };
}

function copyTextToClipboard(text: string): true | string {
  const clipboardCommands: Array<{ binary: string; args: string[] }> = [
    { binary: "wl-copy", args: [] },
    { binary: "xclip", args: ["-selection", "clipboard"] },
    { binary: "xsel", args: ["--clipboard", "--input"] },
    { binary: "pbcopy", args: [] },
    { binary: "clip.exe", args: [] },
  ];

  const errors: string[] = [];

  for (const command of clipboardCommands) {
    const result = spawnSync(command.binary, command.args, {
      input: text,
      encoding: "utf8",
      shell: false,
    });

    if (result.error) {
      const errorCode = (result.error as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        continue;
      }
      errors.push(`${command.binary}: ${String(result.error)}`);
      continue;
    }

    if (typeof result.status === "number" && result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      errors.push(
        stderr
          ? `${command.binary}: exited with status ${result.status}: ${stderr}`
          : `${command.binary}: exited with status ${result.status}`,
      );
      continue;
    }

    return true;
  }

  if (errors.length === 0) {
    return "No clipboard tool found. Install wl-copy, xclip, xsel, pbcopy, or clip.exe";
  }

  return `Failed to copy to clipboard: ${errors.join("; ")}`;
}

function KeymapLine({ hints, maxWidth }: { hints: string[]; maxWidth: number }) {
  return (
    <box style={{ flexDirection: "row", flexWrap: "wrap", width: maxWidth }}>
      {hints.map((hint, index) => (
        <text fg={KEYMAP_TEXT_FG} key={`${hint}-${index}`}>
          {hint}
          {index < hints.length - 1 ? <span fg={KEYMAP_DELIMITER_FG}> | </span> : ""}
        </text>
      ))}
    </box>
  );
}

function TabBar({
  tabs,
  activeId,
  maxWidth,
}: {
  tabs: Array<{ id: string; label: string }>;
  activeId: string;
  maxWidth: number;
}) {
  return (
    <box style={{ flexDirection: "row", marginBottom: 1 }}>
      {tabs.map((tab, index) => (
        <text fg={tab.id === activeId ? TAB_ACTIVE_FG : MUTED_FG} key={tab.id}>
          {clampLine(tab.label, Math.max(4, Math.floor(maxWidth / Math.max(tabs.length, 1)) - 2))}
          {index < tabs.length - 1 ? <span fg={KEYMAP_DELIMITER_FG}> | </span> : ""}
        </text>
      ))}
    </box>
  );
}

function renderTextBlock(lines: string[], width: number, fg?: string) {
  return lines.map((line, index) => (
    <text fg={fg} key={`${line}-${index}`}>
      {fitLine(line, width)}
    </text>
  ));
}

function ConfirmationView({
  confirmation,
  width,
}: {
  confirmation: ConfirmationState;
  width: number;
}) {
  const visibleLines = confirmation.lines.slice(0, Math.max(1, getTerminalRows() - 12));
  return (
    <box border title={confirmation.title} style={{ flexDirection: "column", width, flexGrow: 1 }}>
      {visibleLines.map((line, index) => (
        <text key={`${line}-${index}`}>{fitLine(line, width - 2)}</text>
      ))}
      <text fg={WARNING_FG}>{fitLine(`${confirmation.confirmLabel} with Enter/y. Cancel with Esc/n.`, width - 2)}</text>
    </box>
  );
}

function App({ initialFeature, onExit }: { initialFeature: FeatureName; onExit: () => void }) {
  const terminalCols = getTerminalColumns();
  const terminalRows = getTerminalRows();
  const railWidth = 24;
  const contentWidth = Math.max(56, terminalCols - railWidth - 5);
  const workspacePaneWidth = Math.max(24, contentWidth - 2);
  const mcpPaneWidth = Math.max(24, contentWidth - 2);
  const bottomWidth = Math.max(32, terminalCols - 4);
  const detailPreviewLines = Math.max(4, terminalRows - 18);
  const refreshRequestIdRef = useRef(0);

  const [loadedFeature, setLoadedFeature] = useState<FeatureName>(initialFeature);
  const [railSelection, setRailSelection] = useState<FeatureName>(initialFeature);
  const [focusZone, setFocusZone] = useState<FocusZone>("content");
  const [config, setConfig] = useState<UserConfig>(defaultConfig());
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("roots");
  const [selectedRootIndex, setSelectedRootIndex] = useState(0);
  const [rootSearch, setRootSearch] = useState("");
  const [rootSearchMode, setRootSearchMode] = useState(false);
  const rootSearchModeRef = useRef(false);
  const [selectedRoot, setSelectedRoot] = useState<WorkspaceRef | null>(null);
  const [rememberedRootPath, setRememberedRootPath] = useState<string | null>(null);
  const [selectedAssociateIndex, setSelectedAssociateIndex] = useState(0);
  const [selectedAssociatePaths, setSelectedAssociatePaths] = useState<Set<string>>(new Set());
  const [associateSearch, setAssociateSearch] = useState("");
  const [associateSearchMode, setAssociateSearchMode] = useState(false);
  const associateSearchModeRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<MessageTone>("info");
  const [showKeymaps, setShowKeymaps] = useState(true);
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [previewTargetPath, setPreviewTargetPath] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const pendingCopyPrefixRef = useRef("");
  const pendingCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mcpTemplates, setMcpTemplates] = useState<McpTemplateDoc[]>([]);
  const [mcpVendorConfigs, setMcpVendorConfigs] = useState<McpVendorConfig[]>([]);
  const [mcpSelectedConfiguredIndex, setMcpSelectedConfiguredIndex] = useState(0);
  const [mcpSelectedTemplateIndex, setMcpSelectedTemplateIndex] = useState(0);
  const [mcpSelectedDiffIndex, setMcpSelectedDiffIndex] = useState(0);
  const [mcpTabIndex, setMcpTabIndex] = useState(0);
  const [mcpApplyFieldIndex, setMcpApplyFieldIndex] = useState(0);
  const [mcpApplyActionIndex, setMcpApplyActionIndex] = useState(0);
  const [mcpApplyVendorScopeIndex, setMcpApplyVendorScopeIndex] = useState(0);
  const [mcpApplyTemplateScopeIndex, setMcpApplyTemplateScopeIndex] = useState(0);
  const [mcpTemplatesError, setMcpTemplatesError] = useState<string | null>(null);
  const [mcpVendorError, setMcpVendorError] = useState<string | null>(null);

  const messageFg =
    messageTone === "error" ? ERROR_FG : messageTone === "success" ? SUCCESS_FG : undefined;

  function setStatus(nextMessage: string, tone: MessageTone = "info"): void {
    setMessage(nextMessage);
    setMessageTone(tone);
  }

  function updateRootSearchMode(nextValue: boolean): void {
    rootSearchModeRef.current = nextValue;
    setRootSearchMode(nextValue);
  }

  function updateAssociateSearchMode(nextValue: boolean): void {
    associateSearchModeRef.current = nextValue;
    setAssociateSearchMode(nextValue);
  }

  function clearPendingCopyPrefix(): void {
    pendingCopyPrefixRef.current = "";
    if (pendingCopyTimerRef.current) {
      clearTimeout(pendingCopyTimerRef.current);
      pendingCopyTimerRef.current = null;
    }
  }

  function schedulePendingCopyPrefix(keyName: "1" | "2"): void {
    clearPendingCopyPrefix();
    pendingCopyPrefixRef.current = keyName;
    pendingCopyTimerRef.current = setTimeout(() => {
      pendingCopyTimerRef.current = null;
      pendingCopyPrefixRef.current = "";

      if (loadedFeature !== "workspace-manager" || focusZone !== "content") {
        return;
      }

      if (keyName === "1") {
        cycleWorkspaceTab("roots");
        return;
      }

      if (workspaceTab === "roots") {
        void openSelectedRoot("associate");
        return;
      }

      cycleWorkspaceTab("associate");
    }, 180);
  }

  async function refreshWorkspaces(): Promise<void> {
    const configPath = resolveConfigPath();
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    setIsRefreshing(true);

    try {
      const loadedConfig = await loadConfig(configPath);
      const refs = await discoverWorkspaces(loadedConfig);
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }
      setConfig(loadedConfig);
      setWorkspaces(refs);
      setSelectedRootIndex(findWorkspaceIndexByPath(refs, rememberedRootPath));
      if (refs.length === 0) {
        setStatus(`No root workspaces found in ${configPath}`);
      }
    } catch (error: unknown) {
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }
      setConfig(defaultConfig());
      setWorkspaces([]);
      setSelectedRootIndex(0);
      setStatus(`Failed to load config ${configPath}: ${String(error)}`, "error");
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        setIsRefreshing(false);
      }
    }
  }

  useEffect(() => {
    refreshWorkspaces().catch((error: unknown) => {
      setStatus(`Failed to discover workspaces: ${String(error)}`, "error");
    });
  }, []);

  const filteredRoots = useMemo(() => {
    const term = rootSearch.trim();
    if (!term) {
      return workspaces;
    }

    return workspaces
      .map((workspace) => ({
        workspace,
        score: fuzzyScore(`${workspace.name} ${workspace.path}`, term),
      }))
      .filter((item): item is { workspace: WorkspaceRef; score: number } => item.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.workspace);
  }, [rootSearch, workspaces]);

  const currentRootCandidate = useMemo(() => {
    if (workspaceTab === "roots") {
      return filteredRoots[selectedRootIndex] ?? null;
    }
    return selectedRoot;
  }, [filteredRoots, selectedRoot, selectedRootIndex, workspaceTab]);

  const associateCandidates = useMemo(() => {
    if (!selectedRoot) {
      return [];
    }

    return workspaces.filter((workspace) => workspace.group !== selectedRoot.group && workspace.path !== selectedRoot.path);
  }, [selectedRoot, workspaces]);

  const filteredAssociates = useMemo(() => {
    const term = associateSearch.trim();
    if (!term) {
      return associateCandidates;
    }

    return associateCandidates
      .map((workspace) => ({
        workspace,
        score: fuzzyScore(`${workspace.name} ${workspace.path} ${workspace.group}`, term),
      }))
      .filter((item): item is { workspace: WorkspaceRef; score: number } => item.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.workspace);
  }, [associateCandidates, associateSearch]);

  const selectedAssociates = useMemo(
    () => associateCandidates.filter((workspace) => selectedAssociatePaths.has(workspace.path)),
    [associateCandidates, selectedAssociatePaths],
  );

  const previewFolders = useMemo(() => {
    if (!selectedRoot) {
      return [];
    }
    return buildFolderObjects(selectedRoot, selectedAssociates);
  }, [selectedRoot, selectedAssociates]);

  const previewJson = useMemo(() => JSON.stringify({ folders: previewFolders }, null, 2), [previewFolders]);
  const previewLines = useMemo(() => {
    const lines = previewJson.split("\n");
    if (lines.length <= detailPreviewLines) {
      return lines;
    }
    const kept = lines.slice(0, Math.max(1, detailPreviewLines - 1));
    kept.push(`… (${lines.length - kept.length} more lines)`);
    return kept;
  }, [detailPreviewLines, previewJson]);

  useEffect(() => {
    if (!selectedRoot) {
      setPreviewTargetPath("");
      return;
    }
    let cancelled = false;
    const fallback = path.join(selectedRoot.path, lowerCaseWorkspaceFilename(selectedRoot.name));
    setPreviewTargetPath(fallback);
    void resolveWorkspaceTarget(selectedRoot.path)
      .then((resolved) => {
        if (!cancelled) {
          setPreviewTargetPath(resolved ?? fallback);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewTargetPath(fallback);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRoot]);

  const workspaceTabs = useMemo(
    () => [
      { id: "roots", label: "Roots [1]" },
      { id: "associate", label: "Associate [2]" },
      { id: "save", label: "Save [3]" },
    ],
    [],
  );
  const mcpTabs = useMemo(
    () => [
      { id: "configured", label: "Configured [1]" },
      { id: "templates", label: "Templates [2]" },
      { id: "diff", label: "Diff [3]" },
      { id: "apply", label: "Apply [4]" },
    ],
    [],
  );

  const workspaceKeyHints = useMemo(() => {
    if (workspaceTab === "roots") {
      return [
        "Enter open",
        "/ search",
        "r refresh",
        "c cursor",
        "i inspect",
        "y copy workspace",
        "1y filename",
        "2y dir",
        "Tab rail",
      ];
    }
    if (workspaceTab === "associate") {
      return [
        "space toggle",
        "a/n all-none",
        "Enter save tab",
        "c save+cursor",
        "i inspect",
        "y copy workspace",
        "Esc back",
        "Tab rail",
      ];
    }
    return ["Enter save", "c save+cursor", "i inspect", "y copy workspace", "Esc back", "Tab rail"];
  }, [workspaceTab]);

  const mcpKeyHints = useMemo(() => {
    if (mcpTabIndex === 3) {
      return ["j/k field", "h/l cycle", "Enter preview", "r reload", "Tab rail"];
    }
    return ["j/k move", "1-4 tabs", "r reload", "Tab rail"];
  }, [mcpTabIndex]);

  const rootVisibleRows = useMemo(() => {
    const chromeRows =
      3 +
      (rootSearchMode || rootSearch ? 1 : 0) +
      2 +
      (showKeymaps ? estimateWrappedLineCount(workspaceKeyHints, bottomWidth) : 0);
    return clampVisibleRowCount(terminalRows - chromeRows - 8);
  }, [bottomWidth, rootSearch, rootSearchMode, showKeymaps, terminalRows, workspaceKeyHints]);

  const associateVisibleRows = useMemo(() => {
    const chromeRows =
      3 +
      (associateSearchMode || associateSearch ? 1 : 0) +
      2 +
      (showKeymaps ? estimateWrappedLineCount(workspaceKeyHints, bottomWidth) : 0);
    return clampVisibleRowCount(terminalRows - chromeRows - 8);
  }, [associateSearch, associateSearchMode, bottomWidth, showKeymaps, terminalRows, workspaceKeyHints]);

  const rootWindow = useMemo(
    () => getVisibleWindowBounds(filteredRoots.length, selectedRootIndex, rootVisibleRows),
    [filteredRoots.length, rootVisibleRows, selectedRootIndex],
  );

  const visibleRoots = useMemo(() => filteredRoots.slice(rootWindow.start, rootWindow.end), [filteredRoots, rootWindow.end, rootWindow.start]);

  const associateWindow = useMemo(
    () => getVisibleWindowBounds(filteredAssociates.length, selectedAssociateIndex, associateVisibleRows),
    [associateVisibleRows, filteredAssociates.length, selectedAssociateIndex],
  );

  const visibleAssociates = useMemo(
    () => filteredAssociates.slice(associateWindow.start, associateWindow.end),
    [associateWindow.end, associateWindow.start, filteredAssociates],
  );

  useEffect(() => {
    if (workspaceTab !== "roots") {
      return;
    }
    if (selectedRootIndex >= filteredRoots.length) {
      setSelectedRootIndex(Math.max(0, filteredRoots.length - 1));
    }
  }, [filteredRoots.length, selectedRootIndex, workspaceTab]);

  useEffect(() => {
    if (workspaceTab !== "associate") {
      return;
    }
    if (selectedAssociateIndex >= filteredAssociates.length) {
      setSelectedAssociateIndex(Math.max(0, filteredAssociates.length - 1));
    }
  }, [filteredAssociates.length, selectedAssociateIndex, workspaceTab]);

  function resetAssociateState(): void {
    setSelectedAssociateIndex(0);
    setSelectedAssociatePaths(new Set());
    setAssociateSearch("");
    updateAssociateSearchMode(false);
    setStatus("");
  }

  async function preloadAssociateState(root: WorkspaceRef): Promise<void> {
    const candidates = workspaces.filter((workspace) => workspace.group !== root.group && workspace.path !== root.path);
    const workspaceTarget = await resolveWorkspaceTarget(root.path);
    if (!workspaceTarget) {
      return;
    }

    const workspaceDoc = await loadWorkspace(workspaceTarget);
    const folderPaths = workspaceDoc.folders.map((folder) => folder.absolutePath);
    setSelectedAssociatePaths(buildPreselectedAssociatePaths(root, candidates, folderPaths));
  }

  async function openSelectedRoot(nextTab: WorkspaceTab = "associate"): Promise<void> {
    const root = filteredRoots[selectedRootIndex];
    if (!root) {
      return;
    }

    setSelectedRoot(root);
    setRememberedRootPath(root.path);
    resetAssociateState();
    setWorkspaceTab(nextTab);
    try {
      await preloadAssociateState(root);
    } catch (error: unknown) {
      setSelectedAssociatePaths(new Set());
      setStatus(`Failed to preload associates from existing workspace: ${String(error)}`, "error");
    }
  }

  function toggleCurrentAssociate(): void {
    const current = filteredAssociates[selectedAssociateIndex];
    if (!current) {
      return;
    }

    setSelectedAssociatePaths((currentSelection) => {
      const next = new Set(currentSelection);
      if (next.has(current.path)) {
        next.delete(current.path);
        return next;
      }

      const hasGroupAlready = associateCandidates.some(
        (candidate) => candidate.group === current.group && next.has(candidate.path),
      );
      if (hasGroupAlready) {
        setStatus(`Group '${current.group}' already has a selected workspace`, "error");
        return next;
      }

      next.add(current.path);
      setStatus("");
      return next;
    });
  }

  function selectAssociatesAll(value: boolean): void {
    if (!value) {
      setSelectedAssociatePaths(new Set());
      return;
    }

    const groupFirst = new Map<string, string>();
    associateCandidates.forEach((candidate) => {
      if (!groupFirst.has(candidate.group)) {
        groupFirst.set(candidate.group, candidate.path);
      }
    });

    setSelectedAssociatePaths(new Set(groupFirst.values()));
  }

  async function saveWorkspaceSelection(): Promise<SaveResult | null> {
    if (!selectedRoot || isSaving) {
      return null;
    }

    setIsSaving(true);

    const folders = toWorkspaceWriteEntries(previewFolders);

    try {
      const existingTarget = await resolveWorkspaceTarget(selectedRoot.path);
      const targetPath = existingTarget ?? path.join(selectedRoot.path, lowerCaseWorkspaceFilename(selectedRoot.name));

      await writeWorkspaceFolders(targetPath, folders, false);
      return {
        targetPath,
        folderCount: folders.length,
      };
    } catch (error: unknown) {
      setStatus(`Save failed: ${String(error)}`, "error");
      setWorkspaceTab("associate");
      return null;
    } finally {
      setIsSaving(false);
    }
  }

  async function completePostSaveNavigation(): Promise<void> {
    if (!selectedRoot) {
      return;
    }

    setRememberedRootPath(selectedRoot.path);
    setWorkspaceTab("roots");
    setSelectedRoot(null);
    setRootSearch("");
    updateRootSearchMode(false);
    setSelectedRootIndex(findWorkspaceIndexByPath(workspaces, selectedRoot.path));
    await refreshWorkspaces();
  }

  async function saveSelection(): Promise<void> {
    const result = await saveWorkspaceSelection();
    if (!result) {
      return;
    }

    await completePostSaveNavigation();
    setStatus(`Saved ${result.folderCount} folder(s) to ${result.targetPath}`, "success");
  }

  async function openWorkspaceInCursor(root: WorkspaceRef, workspacePath: string): Promise<true | string> {
    const resolvedRootPath = path.resolve(root.path);
    if (!existsSync(resolvedRootPath)) {
      return `Cannot open in Cursor: folder does not exist: ${resolvedRootPath}`;
    }

    const envExportFile =
      typeof root.metadata["env-export-file"] === "string" ? String(root.metadata["env-export-file"]) : null;

    let cursorEnv: Record<string, string> = {};
    if (envExportFile) {
      try {
        cursorEnv = await resolveExportedEnvironment(envExportFile, resolvedRootPath);
      } catch (error: unknown) {
        return `Cannot open in Cursor: ${String(error)}`;
      }
    }
    cursorEnv = applyDetectedVirtualEnv(resolvedRootPath, cursorEnv);

    const command = buildShellEnvPrefixedCommand("cursor", [workspacePath], cursorEnv);
    const result = launchShellCommand(command, { cwd: resolvedRootPath });

    if (result.error) {
      return `Failed to open Cursor: ${String(result.error)}`;
    }

    if (typeof result.status === "number" && result.status !== 0) {
      return `Cursor exited with status ${result.status}`;
    }

    return true;
  }

  async function saveAndOpenSelectionInCursor(): Promise<void> {
    if (!selectedRoot || isSaving) {
      return;
    }

    const root = selectedRoot;
    const result = await saveWorkspaceSelection();
    if (!result) {
      return;
    }

    const cursorResult = await openWorkspaceInCursor(root, result.targetPath);
    await completePostSaveNavigation();

    if (cursorResult === true) {
      setStatus(`Saved ${result.folderCount} folder(s) and opened in Cursor: ${result.targetPath}`, "success");
      return;
    }

    setStatus(`Saved ${result.folderCount} folder(s) to ${result.targetPath}, but ${cursorResult}`, "error");
  }

  async function openConfigInEditor(): Promise<void> {
    const editor = process.env.EDITOR;
    if (!editor) {
      setStatus("Cannot open config: $EDITOR is not set", "error");
      return;
    }

    const configPath = resolveConfigPath();
    await ensureConfigDir(configPath);
    const result = launchEditorWithFile(editor, configPath);
    if (!result) {
      setStatus("Cannot open config: invalid $EDITOR command", "error");
      return;
    }

    if (result.error) {
      setStatus(`Failed to open config in editor: ${String(result.error)}`, "error");
      return;
    }

    if (typeof result.status === "number" && result.status !== 0) {
      setStatus(`Editor exited with status ${result.status}`, "error");
      return;
    }

    process.stdout.write("\x1b[2J\x1b[H");
    setRenderEpoch((value) => value + 1);
    await refreshWorkspaces();
    setStatus(`Config opened: ${configPath}`);
  }

  async function openSelectedRootInCursor(): Promise<void> {
    const root = filteredRoots[selectedRootIndex];
    if (!root) {
      return;
    }

    const resolvedRootPath = path.resolve(root.path);
    if (!existsSync(resolvedRootPath)) {
      setStatus(`Cannot open in Cursor: folder does not exist: ${resolvedRootPath}`, "error");
      return;
    }

    const workspacePath = await resolveWorkspaceTarget(resolvedRootPath);
    if (!workspacePath) {
      setStatus(`Cannot open in Cursor: no .code-workspace found under ${resolvedRootPath}`, "error");
      return;
    }
    const result = await openWorkspaceInCursor(root, workspacePath);
    if (result !== true) {
      setStatus(result, "error");
      return;
    }

    setStatus(`Opened in Cursor: ${workspacePath}`, "success");
  }

  async function resolveOrCreateRootWorkspacePath(root: WorkspaceRef, foldersForCreation: FolderObject[]): Promise<string | null> {
    const resolvedRootPath = path.resolve(root.path);
    if (!existsSync(resolvedRootPath)) {
      throw new Error(`folder does not exist: ${resolvedRootPath}`);
    }

    let workspacePath = await resolveWorkspaceTarget(resolvedRootPath);
    if (!workspacePath) {
      workspacePath = path.join(resolvedRootPath, lowerCaseWorkspaceFilename(root.name));
      await writeWorkspaceFolders(workspacePath, toWorkspaceWriteEntries(foldersForCreation), false);
    }

    return workspacePath;
  }

  async function openRootWorkspaceInEditor(root: WorkspaceRef, foldersForCreation: FolderObject[]): Promise<void> {
    const editor = process.env.EDITOR;
    if (!editor) {
      setStatus("Cannot inspect workspace: $EDITOR is not set", "error");
      return;
    }

    let workspacePath: string;
    try {
      const resolved = await resolveOrCreateRootWorkspacePath(root, foldersForCreation);
      if (!resolved) {
        return;
      }
      workspacePath = resolved;
    } catch (error: unknown) {
      setStatus(`Cannot inspect workspace: ${String(error)}`, "error");
      return;
    }

    const result = launchEditorWithFile(editor, workspacePath);
    if (!result) {
      setStatus("Cannot inspect workspace: invalid $EDITOR command", "error");
      return;
    }

    if (result.error) {
      setStatus(`Failed to inspect workspace in editor: ${String(result.error)}`, "error");
      return;
    }

    if (typeof result.status === "number" && result.status !== 0) {
      setStatus(`Editor exited with status ${result.status}`, "error");
      return;
    }

    process.stdout.write("\x1b[2J\x1b[H");
    setRenderEpoch((value) => value + 1);
    setStatus(`Inspected in editor: ${workspacePath}`, "success");
  }

  async function copyRootWorkspacePath(root: WorkspaceRef, foldersForCreation: FolderObject[]): Promise<void> {
    let workspacePath: string;
    try {
      const resolved = await resolveOrCreateRootWorkspacePath(root, foldersForCreation);
      if (!resolved) {
        return;
      }
      workspacePath = resolved;
    } catch (error: unknown) {
      setStatus(`Cannot copy workspace path: ${String(error)}`, "error");
      return;
    }

    const result = copyTextToClipboard(workspacePath);
    if (result !== true) {
      setStatus(result, "error");
      return;
    }

    setStatus(`Copied workspace path: ${workspacePath}`, "success");
  }

  async function copyRootWorkspaceFilenameStem(root: WorkspaceRef, foldersForCreation: FolderObject[]): Promise<void> {
    let workspacePath: string;
    try {
      const resolved = await resolveOrCreateRootWorkspacePath(root, foldersForCreation);
      if (!resolved) {
        return;
      }
      workspacePath = resolved;
    } catch (error: unknown) {
      setStatus(`Cannot copy workspace filename: ${String(error)}`, "error");
      return;
    }

    const filenameStem = path.basename(workspacePath, ".code-workspace");
    const result = copyTextToClipboard(filenameStem);
    if (result !== true) {
      setStatus(result, "error");
      return;
    }

    setStatus(`Copied workspace filename: ${filenameStem}`, "success");
  }

  function copyRootDirectoryPath(root: WorkspaceRef): void {
    const directoryPath = path.resolve(root.path);
    const result = copyTextToClipboard(directoryPath);
    if (result !== true) {
      setStatus(result, "error");
      return;
    }

    setStatus(`Copied workspace directory: ${directoryPath}`, "success");
  }

  const mcpTab = mcpTabs[mcpTabIndex]?.id ?? "configured";
  const mcpProjectRoot = currentRootCandidate?.path ?? null;

  async function refreshMcpState(): Promise<void> {
    try {
      const templates = await listMcpTemplates();
      setMcpTemplates(templates);
      setMcpTemplatesError(null);
      if (mcpSelectedTemplateIndex >= templates.length) {
        setMcpSelectedTemplateIndex(Math.max(0, templates.length - 1));
      }
      if (mcpSelectedDiffIndex >= templates.length) {
        setMcpSelectedDiffIndex(Math.max(0, templates.length - 1));
      }
    } catch (error: unknown) {
      setMcpTemplates([]);
      setMcpTemplatesError(String(error));
    }

    if (!mcpProjectRoot) {
      setMcpVendorConfigs([]);
      setMcpVendorError(null);
      return;
    }

    try {
      const configs = await loadMcpVendorConfigs(mcpProjectRoot);
      setMcpVendorConfigs(configs);
      setMcpVendorError(null);
      if (mcpSelectedConfiguredIndex >= configs.length) {
        setMcpSelectedConfiguredIndex(Math.max(0, configs.length - 1));
      }
    } catch (error: unknown) {
      setMcpVendorConfigs([]);
      setMcpVendorError(String(error));
    }
  }

  useEffect(() => {
    void refreshMcpState();
  }, [mcpProjectRoot]);

  const selectedVendorConfig = mcpVendorConfigs[mcpSelectedConfiguredIndex] ?? null;
  const selectedTemplate = mcpTemplates[mcpSelectedTemplateIndex] ?? null;
  const diffTemplates = mcpTemplates;
  const selectedDiffTemplate = diffTemplates[mcpSelectedDiffIndex] ?? null;
  const templateDiffs = useMemo(() => computeVendorTemplateDiffs(mcpTemplates, mcpVendorConfigs), [mcpTemplates, mcpVendorConfigs]);

  const applyPreview = useMemo(() => {
    if (!mcpProjectRoot) {
      return null;
    }
    if (mcpTemplates.length === 0) {
      return null;
    }
    return buildMcpMutationPreview({
      action: MCP_ACTIONS[mcpApplyActionIndex] ?? "add",
      projectRoot: mcpProjectRoot,
      templates: mcpTemplates,
      vendorConfigs: mcpVendorConfigs,
      vendorScope: MCP_VENDOR_SCOPE_OPTIONS[mcpApplyVendorScopeIndex] ?? "selected",
      selectedVendor: selectedVendorConfig?.vendor ?? "claude",
      templateScope: MCP_TEMPLATE_SCOPE_OPTIONS[mcpApplyTemplateScopeIndex] ?? "selected",
      selectedTemplate: selectedTemplate?.name ?? mcpTemplates[0]?.name ?? "",
    });
  }, [
    mcpApplyActionIndex,
    mcpApplyTemplateScopeIndex,
    mcpApplyVendorScopeIndex,
    mcpProjectRoot,
    mcpTemplates,
    mcpVendorConfigs,
    selectedTemplate,
    selectedVendorConfig,
  ]);

  function openMcpConfirmation(): void {
    if (!mcpProjectRoot) {
      setStatus("Select a root workspace before applying MCP changes", "error");
      return;
    }
    if (!applyPreview) {
      setStatus("No MCP preview available", "error");
      return;
    }

    const previewLines = [
      `Project root: ${mcpProjectRoot}`,
      `Action: ${applyPreview.action}`,
      `Vendors: ${applyPreview.vendorNames.join(", ") || "(none)"}`,
      `Templates: ${applyPreview.templateNames.join(", ") || "(none)"}`,
      ...applyPreview.operations.flatMap((operation) => [
        `${operation.vendor} -> ${operation.filePath}`,
        `  changed keys: ${operation.changedKeys.join(", ") || "(none)"}`,
      ]),
    ];

    setConfirmation({
      title: "Confirm MCP Apply",
      lines: previewLines,
      confirmLabel: "Apply changes",
      onConfirm: async () => {
        setIsBusy(true);
        try {
          const result = await applyMcpMutation(applyPreview);
          await refreshMcpState();
          setStatus(`Applied MCP ${result.action} across ${result.updatedVendors.length} vendor target(s)`, "success");
        } catch (error: unknown) {
          setStatus(`Failed to apply MCP changes: ${String(error)}`, "error");
        } finally {
          setIsBusy(false);
        }
      },
    });
  }

  function loadFeature(nextFeature: FeatureName): void {
    setLoadedFeature(nextFeature);
    setRailSelection(nextFeature);
    setFocusZone("content");
    if (nextFeature === "mcp") {
      void refreshMcpState();
    }
  }

  function moveRail(delta: number): void {
    const currentIndex = FEATURE_ITEMS.findIndex((item) => item.id === railSelection);
    const nextIndex = Math.min(Math.max(currentIndex + delta, 0), FEATURE_ITEMS.length - 1);
    const nextFeature = FEATURE_ITEMS[nextIndex]?.id;
    if (nextFeature) {
      setRailSelection(nextFeature);
    }
  }

  async function reloadActiveFeature(): Promise<void> {
    if (loadedFeature === "workspace-manager") {
      await refreshWorkspaces();
      return;
    }
    await refreshMcpState();
    setStatus(`Reloaded MCP state for ${mcpProjectRoot ?? "(no root selected)"}`);
  }

  function cycleWorkspaceTab(nextTab: WorkspaceTab): void {
    if (nextTab === "associate" && !selectedRoot) {
      setStatus("Open a root workspace before entering Associate", "error");
      return;
    }
    if (nextTab === "save" && !selectedRoot) {
      setStatus("Open a root workspace before entering Save", "error");
      return;
    }
    setWorkspaceTab(nextTab);
  }

  function cycleMcpApplyValue(delta: number): void {
    if (mcpApplyFieldIndex === 0) {
      setMcpApplyActionIndex((current) => (current + delta + MCP_ACTIONS.length) % MCP_ACTIONS.length);
      return;
    }
    if (mcpApplyFieldIndex === 1) {
      setMcpApplyVendorScopeIndex((current) => (current + delta + MCP_VENDOR_SCOPE_OPTIONS.length) % MCP_VENDOR_SCOPE_OPTIONS.length);
      return;
    }
    if (mcpApplyFieldIndex === 2) {
      setMcpApplyTemplateScopeIndex((current) => (current + delta + MCP_TEMPLATE_SCOPE_OPTIONS.length) % MCP_TEMPLATE_SCOPE_OPTIONS.length);
    }
  }

  useKeyboard((key) => {
    if (confirmation) {
      if (key.name === "escape" || key.name === "n") {
        setConfirmation(null);
        return;
      }
      if (key.name === "return" || key.name === "y") {
        const current = confirmation;
        setConfirmation(null);
        void current.onConfirm();
      }
      return;
    }

    if ((key.ctrl && key.name === "c") || key.name === "q") {
      onExit();
      return;
    }
    if (isQuestionKey(key)) {
      setShowKeymaps((current) => !current);
      return;
    }

    if (rootSearchModeRef.current && loadedFeature === "workspace-manager" && workspaceTab === "roots") {
      if (key.name === "escape" || key.name === "return") {
        updateRootSearchMode(false);
        return;
      }
      if (key.name === "backspace") {
        setRootSearch((current) => current.slice(0, -1));
        return;
      }
      if (isPrintableKey(key.sequence)) {
        setRootSearch((current) => `${current}${key.sequence}`);
      }
      return;
    }

    if (associateSearchModeRef.current && loadedFeature === "workspace-manager" && workspaceTab === "associate") {
      if (key.name === "escape" || key.name === "return") {
        updateAssociateSearchMode(false);
        return;
      }
      if (key.name === "backspace") {
        setAssociateSearch((current) => current.slice(0, -1));
        return;
      }
      if (isPrintableKey(key.sequence)) {
        setAssociateSearch((current) => `${current}${key.sequence}`);
      }
      return;
    }

    if (key.name === "o") {
      void openConfigInEditor();
      return;
    }
    if (key.name === "tab") {
      if (focusZone === "rail") {
        setFocusZone("content");
      } else {
        setRailSelection(loadedFeature);
        setFocusZone("rail");
      }
      return;
    }

    if (pendingCopyPrefixRef.current) {
      const prefix = pendingCopyPrefixRef.current;
      clearPendingCopyPrefix();

      if (prefix === "1" && key.name === "y") {
        if (workspaceTab === "roots") {
          const root = filteredRoots[selectedRootIndex];
          if (root) {
            void copyRootWorkspaceFilenameStem(root, buildFolderObjects(root, []));
          }
          return;
        }
        if (selectedRoot) {
          void copyRootWorkspaceFilenameStem(selectedRoot, previewFolders);
          return;
        }
      }

      if (prefix === "2" && key.name === "y") {
        if (workspaceTab === "roots") {
          const root = filteredRoots[selectedRootIndex];
          if (root) {
            copyRootDirectoryPath(root);
          }
          return;
        }
        if (selectedRoot) {
          copyRootDirectoryPath(selectedRoot);
          return;
        }
      }
    }

    if (!pendingCopyPrefixRef.current && focusZone === "content" && loadedFeature === "workspace-manager" && (key.name === "1" || key.name === "2")) {
      schedulePendingCopyPrefix(key.name);
      return;
    }

    if (focusZone === "rail") {
      if (key.name === "j" || key.name === "down") {
        moveRail(1);
      }
      if (key.name === "k" || key.name === "up") {
        moveRail(-1);
      }
      if (key.name === "1") {
        setRailSelection("workspace-manager");
      }
      if (key.name === "2") {
        setRailSelection("mcp");
      }
      if (key.name === "return") {
        loadFeature(railSelection);
      }
      if (key.name === "L" || key.sequence === "L") {
        setRailSelection(loadedFeature);
        setFocusZone("content");
      }
      return;
    }

    if (key.name === "H" || key.sequence === "H") {
      setRailSelection(loadedFeature);
      setFocusZone("rail");
      return;
    }

    if (key.name === "r") {
      void reloadActiveFeature();
      return;
    }

    if (loadedFeature === "workspace-manager") {
      if (key.name === "1") {
        cycleWorkspaceTab("roots");
        return;
      }
      if (key.name === "2") {
        if (workspaceTab === "roots") {
          void openSelectedRoot("associate");
          return;
        }
        cycleWorkspaceTab("associate");
        return;
      }
      if (key.name === "3") {
        if (workspaceTab === "roots") {
          void openSelectedRoot("save");
          return;
        }
        cycleWorkspaceTab("save");
        return;
      }

      if (workspaceTab === "roots") {
        if (key.name === "j" || key.name === "down") {
          setSelectedRootIndex((current) => Math.min(current + 1, Math.max(0, filteredRoots.length - 1)));
        }
        if (key.name === "k" || key.name === "up") {
          setSelectedRootIndex((current) => Math.max(current - 1, 0));
        }
        if (key.name === "return") {
          void openSelectedRoot();
        }
        if (key.name === "c") {
          void openSelectedRootInCursor();
        }
        if (key.name === "i") {
          const root = filteredRoots[selectedRootIndex];
          if (root) {
            void openRootWorkspaceInEditor(root, buildFolderObjects(root, []));
          }
        }
        if (key.name === "y") {
          const root = filteredRoots[selectedRootIndex];
          if (root) {
            void copyRootWorkspacePath(root, buildFolderObjects(root, []));
          }
        }
        if (key.name === "slash" || key.name === "/" || key.sequence === "/") {
          updateRootSearchMode(true);
        }
        if (key.name === "escape" && rootSearch) {
          setRootSearch("");
          setSelectedRootIndex(0);
        }
        return;
      }

      if (workspaceTab === "associate") {
        if (key.name === "j" || key.name === "down") {
          setSelectedAssociateIndex((current) => Math.min(current + 1, Math.max(0, filteredAssociates.length - 1)));
        }
        if (key.name === "k" || key.name === "up") {
          setSelectedAssociateIndex((current) => Math.max(current - 1, 0));
        }
        if (key.name === "space") {
          toggleCurrentAssociate();
        }
        if (key.name === "a") {
          selectAssociatesAll(true);
        }
        if (key.name === "n") {
          selectAssociatesAll(false);
        }
        if (key.name === "s" || key.name === "return") {
          setStatus("");
          setWorkspaceTab("save");
        }
        if (key.name === "c") {
          void saveAndOpenSelectionInCursor();
        }
        if (key.name === "i" && selectedRoot) {
          void openRootWorkspaceInEditor(selectedRoot, previewFolders);
        }
        if (key.name === "y" && selectedRoot) {
          void copyRootWorkspacePath(selectedRoot, previewFolders);
        }
        if (key.name === "slash" || key.name === "/" || key.sequence === "/") {
          updateAssociateSearchMode(true);
        }
        if (key.name === "escape") {
          setWorkspaceTab("roots");
          setSelectedRoot(null);
          setStatus("");
        }
        return;
      }

      if (workspaceTab === "save") {
        if (key.name === "return" || key.name === "s") {
          void saveSelection();
        }
        if (key.name === "c") {
          void saveAndOpenSelectionInCursor();
        }
        if (key.name === "i" && selectedRoot) {
          void openRootWorkspaceInEditor(selectedRoot, previewFolders);
        }
        if (key.name === "y" && selectedRoot) {
          void copyRootWorkspacePath(selectedRoot, previewFolders);
        }
        if (key.name === "escape" || key.name === "n") {
          setWorkspaceTab("associate");
          setStatus("");
        }
      }
      return;
    }

    if (key.name === "1") {
      setMcpTabIndex(0);
      return;
    }
    if (key.name === "2") {
      setMcpTabIndex(1);
      return;
    }
    if (key.name === "3") {
      setMcpTabIndex(2);
      return;
    }
    if (key.name === "4") {
      setMcpTabIndex(3);
      return;
    }

    if (mcpTabIndex === 0) {
      if (key.name === "j" || key.name === "down") {
        setMcpSelectedConfiguredIndex((current) => Math.min(current + 1, Math.max(0, mcpVendorConfigs.length - 1)));
      }
      if (key.name === "k" || key.name === "up") {
        setMcpSelectedConfiguredIndex((current) => Math.max(current - 1, 0));
      }
      return;
    }

    if (mcpTabIndex === 1) {
      if (key.name === "j" || key.name === "down") {
        setMcpSelectedTemplateIndex((current) => Math.min(current + 1, Math.max(0, mcpTemplates.length - 1)));
      }
      if (key.name === "k" || key.name === "up") {
        setMcpSelectedTemplateIndex((current) => Math.max(current - 1, 0));
      }
      return;
    }

    if (mcpTabIndex === 2) {
      if (key.name === "j" || key.name === "down") {
        setMcpSelectedDiffIndex((current) => Math.min(current + 1, Math.max(0, diffTemplates.length - 1)));
      }
      if (key.name === "k" || key.name === "up") {
        setMcpSelectedDiffIndex((current) => Math.max(current - 1, 0));
      }
      return;
    }

    if (mcpTabIndex === 3) {
      if (key.name === "j" || key.name === "down") {
        setMcpApplyFieldIndex((current) => Math.min(current + 1, 3));
      }
      if (key.name === "k" || key.name === "up") {
        setMcpApplyFieldIndex((current) => Math.max(current - 1, 0));
      }
      if (key.name === "h" || key.name === "left") {
        cycleMcpApplyValue(-1);
      }
      if (key.name === "l" || key.name === "right") {
        cycleMcpApplyValue(1);
      }
      if (key.name === "return") {
        openMcpConfirmation();
      }
    }
  });

  const workspaceRightLines = useMemo(() => {
    const root = currentRootCandidate;
    if (!root) {
      return ["No root selected.", "Pick a root workspace on the left.", "", "MCP uses the current root as its project root."];
    }

    const metadataEntries = Object.entries(root.metadata);
    const lines = [
      `Name: ${root.name}`,
      `Group: ${root.group}`,
      `Path: ${root.path}`,
      `Exists: ${root.existsOnDisk ? "yes" : "no"}`,
      "",
      "Metadata:",
    ];
    if (metadataEntries.length === 0) {
      lines.push("  (none)");
    } else {
      metadataEntries.forEach(([key, value]) => {
        lines.push(`  ${key}: ${String(value)}`);
      });
    }

    if (workspaceTab === "save") {
      lines.push("");
      lines.push(`Target: ${previewTargetPath}`);
      lines.push(`Folders: ${1 + selectedAssociates.length}`);
      lines.push(...previewLines);
    } else if (workspaceTab === "associate") {
      lines.push("");
      lines.push(`Selected associates: ${selectedAssociates.length}`);
      selectedAssociates.slice(0, detailPreviewLines).forEach((workspace) => {
        lines.push(`  - ${workspace.name}`);
      });
    }

    return lines;
  }, [currentRootCandidate, detailPreviewLines, previewLines, previewTargetPath, selectedAssociates, workspaceTab]);
  const workspaceInlineVisibleRows = useMemo(() => {
    const chromeRows =
      5 +
      (workspaceTab === "roots" && (rootSearchMode || rootSearch) ? 1 : 0) +
      (workspaceTab === "associate" && (associateSearchMode || associateSearch) ? 1 : 0) +
      (showKeymaps ? estimateWrappedLineCount(workspaceKeyHints, bottomWidth) : 0);
    const reservedDetailRows =
      workspaceTab === "save"
        ? Math.min(detailPreviewLines + 6, 16)
        : workspaceTab === "associate"
          ? Math.min(5 + selectedAssociates.length, 9)
          : 8;
    return clampVisibleRowCount(terminalRows - chromeRows - reservedDetailRows);
  }, [
    associateSearch,
    associateSearchMode,
    bottomWidth,
    detailPreviewLines,
    rootSearch,
    rootSearchMode,
    selectedAssociates.length,
    showKeymaps,
    terminalRows,
    workspaceKeyHints,
    workspaceTab,
  ]);

  const configuredListVisibleRows = Math.max(4, terminalRows - 18);
  const configuredWindow = getVisibleWindowBounds(mcpVendorConfigs.length, mcpSelectedConfiguredIndex, configuredListVisibleRows);
  const visibleConfigured = mcpVendorConfigs.slice(configuredWindow.start, configuredWindow.end);

  const templateWindow = getVisibleWindowBounds(mcpTemplates.length, mcpSelectedTemplateIndex, configuredListVisibleRows);
  const visibleTemplates = mcpTemplates.slice(templateWindow.start, templateWindow.end);

  const diffWindow = getVisibleWindowBounds(diffTemplates.length, mcpSelectedDiffIndex, configuredListVisibleRows);
  const visibleDiffTemplates = diffTemplates.slice(diffWindow.start, diffWindow.end);

  const configuredDetailLines = useMemo(() => {
    if (!selectedVendorConfig) {
      return [
        `Project root: ${mcpProjectRoot ?? "(none)"}`,
        "",
        "No vendor config selected.",
      ];
    }

    const lines = [
      `Project root: ${mcpProjectRoot ?? "(none)"}`,
      `Vendor: ${selectedVendorConfig.vendor}`,
      `Path: ${selectedVendorConfig.filePath}`,
      `Exists: ${selectedVendorConfig.exists ? "yes" : "no"}`,
      `Server keys: ${selectedVendorConfig.serverKeys.length}`,
      "",
    ];

    if (selectedVendorConfig.diagnostics.length > 0) {
      lines.push("Diagnostics:");
      selectedVendorConfig.diagnostics.forEach((diagnostic) => {
        lines.push(`  ${diagnostic}`);
      });
      return lines;
    }

    if (selectedVendorConfig.serverKeys.length === 0) {
      lines.push("No configured MCP servers.");
      return lines;
    }

    lines.push("Configured servers:");
    selectedVendorConfig.serverKeys.forEach((serverKey) => {
      lines.push(`  ${serverKey}`);
    });
    return lines;
  }, [mcpProjectRoot, selectedVendorConfig]);

  const templateDetailLines = useMemo(() => {
    if (!selectedTemplate) {
      return ["No template selected."];
    }
    const lines = [
      `Template: ${selectedTemplate.name}`,
      `Path: ${selectedTemplate.filePath}`,
      `Server keys: ${selectedTemplate.serverKeys.length}`,
      "",
      ...selectedTemplate.previewLines.slice(0, detailPreviewLines),
    ];
    return lines;
  }, [detailPreviewLines, selectedTemplate]);

  const diffDetailLines = useMemo(() => {
    if (!selectedDiffTemplate) {
      return ["No template selected."];
    }
    const lines = [
      `Template: ${selectedDiffTemplate.name}`,
      "",
    ];
    const templateDiff = templateDiffs.find((entry) => entry.templateName === selectedDiffTemplate.name);
    if (!templateDiff) {
      lines.push("No diff available.");
      return lines;
    }
    templateDiff.vendors.forEach((vendor) => {
      const status = vendor.missingKeys.length === 0 ? "present" : `missing: ${vendor.missingKeys.join(", ")}`;
      lines.push(`${vendor.vendor}: ${status}`);
    });
    return lines;
  }, [selectedDiffTemplate, templateDiffs]);

  const applyDetailLines = useMemo(() => {
    const lines = [
      `Project root: ${mcpProjectRoot ?? "(none)"}`,
      `Action: ${MCP_ACTIONS[mcpApplyActionIndex] ?? "add"}`,
      `Vendor scope: ${MCP_VENDOR_SCOPE_OPTIONS[mcpApplyVendorScopeIndex]}`,
      `Template scope: ${MCP_TEMPLATE_SCOPE_OPTIONS[mcpApplyTemplateScopeIndex]}`,
      `Selected vendor: ${selectedVendorConfig?.vendor ?? "(none)"}`,
      `Selected template: ${selectedTemplate?.name ?? "(none)"}`,
      "",
    ];

    if (!applyPreview) {
      lines.push("No preview available.");
      return lines;
    }

    lines.push(`Vendor targets: ${applyPreview.vendorNames.join(", ") || "(none)"}`);
    lines.push(`Template targets: ${applyPreview.templateNames.join(", ") || "(none)"}`);
    lines.push("");
    applyPreview.operations.forEach((operation) => {
      lines.push(`${operation.vendor} -> ${operation.filePath}`);
      lines.push(`  changed keys: ${operation.changedKeys.join(", ") || "(none)"}`);
      if (operation.willInitialize) {
        lines.push("  initializes missing or invalid config to {\"mcpServers\":{}}");
      }
    });
    return lines;
  }, [
    applyPreview,
    mcpApplyActionIndex,
    mcpApplyTemplateScopeIndex,
    mcpApplyVendorScopeIndex,
    mcpProjectRoot,
    selectedTemplate,
    selectedVendorConfig,
  ]);

  const mcpDetailLines = useMemo(() => {
    if (mcpTabIndex === 0) {
      return configuredDetailLines;
    }
    if (mcpTabIndex === 1) {
      return templateDetailLines;
    }
    if (mcpTabIndex === 2) {
      return diffDetailLines;
    }
    return applyDetailLines;
  }, [applyDetailLines, configuredDetailLines, diffDetailLines, mcpTabIndex, templateDetailLines]);

  function renderWorkspacePanel() {
    const title =
      workspaceTab === "roots" ? "Root Workspace" : workspaceTab === "associate" ? "Associate Workspaces" : "Save Preview";

    return (
      <box key={`workspace-feature-${renderEpoch}`} style={{ flexDirection: "column", flexGrow: 1 }}>
        <TabBar tabs={workspaceTabs} activeId={workspaceTab} maxWidth={contentWidth - 4} />
        <box border title={title} style={{ width: workspacePaneWidth + 2, flexDirection: "column", flexGrow: 1 }}>
          {workspaceTab === "roots" ? (
            <>
              <text>{fitLine(`Configured groups: ${config.groups.length}`, workspacePaneWidth)}</text>
              {rootSearchMode || rootSearch ? (
                <text>{fitLine(`Search: ${rootSearchMode ? "(typing...)" : ""} ${rootSearch}`.trimEnd(), workspacePaneWidth)}</text>
              ) : null}
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                {visibleRoots.slice(0, workspaceInlineVisibleRows).map((workspace, visibleIndex) => {
                  const index = rootWindow.start + visibleIndex;
                  return (
                    <text
                      key={workspace.id}
                      bg={index === selectedRootIndex ? ROW_ACTIVE_BG : undefined}
                      fg={index === selectedRootIndex ? ROW_ACTIVE_FG : undefined}
                    >
                      {fitLine(`${linePrefix(index === selectedRootIndex)} ${workspaceLabel(workspace)}`, workspacePaneWidth)}
                    </text>
                  );
                })}
                {workspaces.length === 0 ? <text>No root workspaces available.</text> : null}
                {workspaces.length > 0 && filteredRoots.length === 0 ? <text>No root workspaces match the current search.</text> : null}
              </box>
            </>
          ) : null}

          {workspaceTab === "associate" ? (
            <>
              <text>{fitLine(selectedRoot ? workspaceLabel(selectedRoot) : "", workspacePaneWidth)}</text>
              {associateSearchMode || associateSearch ? (
                <text>{fitLine(`Search: ${associateSearchMode ? "(typing...)" : ""} ${associateSearch}`.trimEnd(), workspacePaneWidth)}</text>
              ) : null}
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                {visibleAssociates.slice(0, workspaceInlineVisibleRows).map((workspace, visibleIndex) => {
                  const index = associateWindow.start + visibleIndex;
                  return (
                    <text
                      key={workspace.id}
                      bg={
                        selectedAssociatePaths.has(workspace.path)
                          ? index === selectedAssociateIndex
                            ? ROW_SELECTED_ACTIVE_BG
                            : ROW_SELECTED_BG
                          : index === selectedAssociateIndex
                            ? ROW_ACTIVE_BG
                            : undefined
                      }
                      fg={index === selectedAssociateIndex ? ROW_ACTIVE_FG : undefined}
                    >
                      {fitLine(
                        `${linePrefix(index === selectedAssociateIndex)} [${selectedAssociatePaths.has(workspace.path) ? "x" : " "}] ${workspaceLabel(workspace)}`,
                        workspacePaneWidth,
                      )}
                    </text>
                  );
                })}
                {associateCandidates.length === 0 ? <text>No available associates for this root.</text> : null}
                {associateCandidates.length > 0 && filteredAssociates.length === 0 ? <text>No associate workspaces match the current search.</text> : null}
              </box>
            </>
          ) : null}

          {workspaceTab === "save" ? (
            <>
              <text>{fitLine(`Root: ${selectedRoot ? workspaceLabel(selectedRoot) : ""}`, workspacePaneWidth)}</text>
              <text>{fitLine(`Target: ${previewTargetPath}`, workspacePaneWidth)}</text>
              <text>{fitLine(`Associates: ${selectedAssociates.length}`, workspacePaneWidth)}</text>
              <text>{fitLine(`Folders to write: ${selectedRoot ? 1 + selectedAssociates.length : 0}`, workspacePaneWidth)}</text>
              <text>{fitLine("Confirm save?", workspacePaneWidth)}</text>
              {selectedAssociates.length === 0 ? (
                <text fg={WARNING_FG}>
                  {fitLine("Warning: no associate workspaces selected; only root workspace will be saved", workspacePaneWidth)}
                </text>
              ) : null}
            </>
          ) : null}

          <box style={{ flexDirection: "column", marginTop: 1 }}>
            {renderTextBlock(workspaceRightLines, workspacePaneWidth)}
          </box>
        </box>
      </box>
    );
  }

  function renderMcpPanel() {
    const paneTitle = mcpTabs[mcpTabIndex]?.id ?? "configured";

    return (
      <box key={`mcp-feature-${renderEpoch}`} style={{ flexDirection: "column", flexGrow: 1 }}>
        <TabBar tabs={mcpTabs} activeId={paneTitle} maxWidth={contentWidth - 4} />
        <box border title={mcpTabs[mcpTabIndex]?.label ?? "MCP"} style={{ width: mcpPaneWidth + 2, flexDirection: "column", flexGrow: 1 }}>
          {!mcpProjectRoot ? <text>{fitLine("No root workspace selected.", mcpPaneWidth)}</text> : null}
          {mcpTemplatesError ? <text fg={ERROR_FG}>{fitLine(`Templates error: ${mcpTemplatesError}`, mcpPaneWidth)}</text> : null}
          {mcpVendorError ? <text fg={ERROR_FG}>{fitLine(`Vendor error: ${mcpVendorError}`, mcpPaneWidth)}</text> : null}

          {mcpTabIndex === 0 ? (
            visibleConfigured.map((configEntry, visibleIndex) => {
              const index = configuredWindow.start + visibleIndex;
              return (
                <text
                  key={configEntry.vendor}
                  bg={index === mcpSelectedConfiguredIndex ? ROW_ACTIVE_BG : undefined}
                  fg={index === mcpSelectedConfiguredIndex ? ROW_ACTIVE_FG : undefined}
                >
                  {fitLine(
                    `${linePrefix(index === mcpSelectedConfiguredIndex)} ${configEntry.vendor} (${configEntry.serverKeys.length})`,
                    mcpPaneWidth,
                  )}
                </text>
              );
            })
          ) : null}

          {mcpTabIndex === 1 ? (
            visibleTemplates.map((template, visibleIndex) => {
              const index = templateWindow.start + visibleIndex;
              return (
                <text
                  key={template.name}
                  bg={index === mcpSelectedTemplateIndex ? ROW_ACTIVE_BG : undefined}
                  fg={index === mcpSelectedTemplateIndex ? ROW_ACTIVE_FG : undefined}
                >
                  {fitLine(`${linePrefix(index === mcpSelectedTemplateIndex)} ${template.name}`, mcpPaneWidth)}
                </text>
              );
            })
          ) : null}

          {mcpTabIndex === 2 ? (
            visibleDiffTemplates.map((template, visibleIndex) => {
              const index = diffWindow.start + visibleIndex;
              const diff = templateDiffs.find((entry) => entry.templateName === template.name);
              const missingCount = diff ? diff.vendors.reduce((count, vendor) => count + vendor.missingKeys.length, 0) : 0;
              return (
                <text
                  key={template.name}
                  bg={index === mcpSelectedDiffIndex ? ROW_ACTIVE_BG : undefined}
                  fg={index === mcpSelectedDiffIndex ? ROW_ACTIVE_FG : undefined}
                >
                  {fitLine(`${linePrefix(index === mcpSelectedDiffIndex)} ${template.name} (${missingCount} missing)`, mcpPaneWidth)}
                </text>
              );
            })
          ) : null}

          {mcpTabIndex === 3 ? (
            <>
              {[
                `Action: ${MCP_ACTIONS[mcpApplyActionIndex] ?? "add"}`,
                `Vendor scope: ${MCP_VENDOR_SCOPE_OPTIONS[mcpApplyVendorScopeIndex]}`,
                `Template scope: ${MCP_TEMPLATE_SCOPE_OPTIONS[mcpApplyTemplateScopeIndex]}`,
                "Enter: preview + confirm",
              ].map((line, index) => (
                <text
                  key={`${line}-${index}`}
                  bg={index === mcpApplyFieldIndex ? ROW_ACTIVE_BG : undefined}
                  fg={index === mcpApplyFieldIndex ? ROW_ACTIVE_FG : undefined}
                >
                  {fitLine(`${linePrefix(index === mcpApplyFieldIndex)} ${line}`, mcpPaneWidth)}
                </text>
              ))}
            </>
          ) : null}

          <box style={{ flexDirection: "column", marginTop: 1 }}>
            {renderTextBlock(mcpDetailLines, mcpPaneWidth)}
          </box>
        </box>
      </box>
    );
  }

  return (
    <box key={`app-shell-${renderEpoch}`} style={{ flexDirection: "column", paddingTop: 1 }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <box border borderColor={focusZone === "rail" ? TAB_ACTIVE_FG : BORDER_FG} title="APPS" style={{ width: railWidth, flexDirection: "column" }}>
          {FEATURE_ITEMS.map((item) => {
            const active = item.id === railSelection;
            return (
              <text key={item.id} bg={active ? RAIL_ACTIVE_BG : undefined} fg={active ? TAB_ACTIVE_FG : undefined}>
                {fitLine(`${linePrefix(active)} ${item.label} [${item.index}]`, railWidth - 2)}
              </text>
            );
          })}
        </box>

        <box
          border
          borderColor={focusZone === "content" ? TAB_ACTIVE_FG : BORDER_FG}
          title={loadedFeature === "workspace-manager" ? "WORKSPACE MANAGER" : "MCP"}
          style={{ width: contentWidth, flexDirection: "column", marginLeft: 1 }}
        >
          {confirmation ? (
            <ConfirmationView confirmation={confirmation} width={contentWidth - 2} />
          ) : loadedFeature === "workspace-manager" ? (
            renderWorkspacePanel()
          ) : (
            renderMcpPanel()
          )}
        </box>
      </box>

      <box border title="Status" style={{ marginTop: 1, flexDirection: "column", width: bottomWidth }}>
        <text fg={messageFg}>
          {fitLine(
            isBusy
              ? "Applying changes..."
              : isRefreshing
                ? "Loading workspaces..."
                : message || (loadedFeature === "mcp" && !mcpProjectRoot ? "MCP is waiting for a selected root workspace." : ""),
            bottomWidth - 2,
          )}
        </text>
        {showKeymaps ? (
          <KeymapLine
            hints={confirmation ? ["Enter/y confirm", "Esc/n cancel", "q quit"] : loadedFeature === "workspace-manager" ? workspaceKeyHints : mcpKeyHints}
            maxWidth={bottomWidth - 2}
          />
        ) : null}
      </box>
    </box>
  );
}

export async function runTui(options?: { initialFeature?: FeatureName }): Promise<void> {
  const renderer = (await createCliRenderer({
    exitOnCtrlC: false,
  })) as { destroy: () => void };
  const root = createRoot(renderer);

  function exitTui(): void {
    root.unmount();
    renderer.destroy();
    process.stdout.write("\x1b[2J\x1b[H\x1b[0m");
  }

  root.render(<App initialFeature={options?.initialFeature ?? "workspace-manager"} onExit={exitTui} />);
}
