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
import { loadWorkspace, resolveWorkspaceTarget, writeWorkspaceFolders } from "../io/workspace.js";

type Screen = "roots" | "associate" | "save";
type MessageTone = "info" | "success" | "error";

type KeyboardEventLike = {
  name: string;
  ctrl: boolean;
  sequence: string;
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

function getRowMaxWidth(): number {
  const cols = process.stdout.columns ?? 100;
  return Math.max(24, cols - 12);
}

function getOuterLineMaxWidth(): number {
  const cols = process.stdout.columns ?? 100;
  return Math.max(20, cols - 12);
}

function getPreviewLineMaxWidth(): number {
  const cols = process.stdout.columns ?? 100;
  return Math.max(16, cols - 16);
}

function getPreviewMaxLines(): number {
  const rows = process.stdout.rows ?? 40;
  return Math.max(4, rows - 16);
}

function estimateWrappedLineCount(lines: string[], maxWidth: number): number {
  if (maxWidth <= 0 || lines.length === 0) {
    return 0;
  }

  const combined = lines.join(" | ");
  return Math.max(1, Math.ceil(Math.max(1, combined.length) / maxWidth));
}

function clampVisibleRowCount(value: number): number {
  return Math.max(1, value);
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

function clampLine(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) {
    return text;
  }
  if (maxWidth <= 1) {
    return text.slice(0, maxWidth);
  }
  return `${text.slice(0, maxWidth - 1)}…`;
}

function fitLine(text: string, maxWidth: number): string {
  return clampLine(text, maxWidth).padEnd(maxWidth, " ");
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

type SaveResult = {
  targetPath: string;
  folderCount: number;
};

type FolderObject = Record<string, unknown>;
type WorkspaceWriteEntry = { name: string; path: string; metadata: Record<string, unknown> };

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

function KeymapLine({ hints }: { hints: string[] }) {
  return (
    <box style={{ flexDirection: "row", flexWrap: "wrap", width: "100%" }}>
      {hints.map((hint, index) => (
        <text fg={KEYMAP_TEXT_FG} key={`${hint}-${index}`}>
          {hint}
          {index < hints.length - 1 ? <span fg={KEYMAP_DELIMITER_FG}> | </span> : ""}
        </text>
      ))}
    </box>
  );
}

function App({ onExit }: { onExit: () => void }) {
  const rowMaxWidth = getRowMaxWidth();
  const outerLineMaxWidth = getOuterLineMaxWidth();
  const previewLineMaxWidth = getPreviewLineMaxWidth();
  const previewMaxLines = getPreviewMaxLines();
  const terminalRows = process.stdout.rows ?? 40;
  const [screen, setScreen] = useState<Screen>("roots");
  const [config, setConfig] = useState<UserConfig>(defaultConfig());
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [selectedRootIndex, setSelectedRootIndex] = useState(0);
  const [rootSearch, setRootSearch] = useState("");
  const [rootSearchMode, setRootSearchMode] = useState(false);
  const [selectedRoot, setSelectedRoot] = useState<WorkspaceRef | null>(null);
  const [rememberedRootPath, setRememberedRootPath] = useState<string | null>(null);
  const [selectedAssociateIndex, setSelectedAssociateIndex] = useState(0);
  const [selectedAssociatePaths, setSelectedAssociatePaths] = useState<Set<string>>(new Set());
  const [associateSearch, setAssociateSearch] = useState("");
  const [associateSearchMode, setAssociateSearchMode] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<MessageTone>("info");
  const [showKeymaps, setShowKeymaps] = useState(true);
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [previewTargetPath, setPreviewTargetPath] = useState("");
  const [pendingCopyPrefix, setPendingCopyPrefix] = useState("");
  const refreshRequestIdRef = useRef(0);
  const messageFg =
    messageTone === "error" ? "#f87171" : messageTone === "success" ? "#4ade80" : undefined;

  function setStatus(nextMessage: string, tone: MessageTone = "info"): void {
    setMessage(nextMessage);
    setMessageTone(tone);
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
    if (lines.length <= previewMaxLines) {
      return lines;
    }
    const kept = lines.slice(0, Math.max(1, previewMaxLines - 1));
    kept.push(`… (${lines.length - kept.length} more lines)`);
    return kept;
  }, [previewJson, previewMaxLines]);
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

  const rootKeyHints = useMemo(
    () => ["j/k move", "Enter open", "/ search", "r refresh", "c cursor", "i inspect", "y copy path", "o config", "? keymaps", "q quit"],
    [],
  );

  const associateKeyHints = useMemo(
    () => [
      "j/k move",
      "space toggle",
      "a/n all-none",
      "/ search",
      "s save",
      "c cursor",
      "i inspect",
      "y copy path",
      "esc back",
      "o config",
      "? keymaps",
      "q quit",
    ],
    [],
  );

  const saveKeyHints = useMemo(
    () => ["Enter/s save", "c save+cursor", "i inspect", "y copy path", "Esc/n back", "o config", "? keymaps"],
    [],
  );

  const rootVisibleRows = useMemo(() => {
    const chromeRows =
      1 +
      (rootSearchMode || rootSearch ? 1 : 0) +
      1 +
      1 +
      (showKeymaps ? estimateWrappedLineCount(rootKeyHints, outerLineMaxWidth) : 0);
    return clampVisibleRowCount(terminalRows - chromeRows - 4);
  }, [outerLineMaxWidth, rootKeyHints, rootSearch, rootSearchMode, showKeymaps, terminalRows]);

  const associateVisibleRows = useMemo(() => {
    const chromeRows =
      1 +
      (associateSearchMode || associateSearch ? 1 : 0) +
      1 +
      1 +
      (showKeymaps ? estimateWrappedLineCount(associateKeyHints, outerLineMaxWidth) : 0);
    return clampVisibleRowCount(terminalRows - chromeRows - 4);
  }, [associateKeyHints, associateSearch, associateSearchMode, outerLineMaxWidth, showKeymaps, terminalRows]);

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
    if (screen !== "roots") {
      return;
    }
    if (selectedRootIndex >= filteredRoots.length) {
      setSelectedRootIndex(Math.max(0, filteredRoots.length - 1));
    }
  }, [filteredRoots.length, selectedRootIndex, screen]);

  useEffect(() => {
    if (screen !== "associate") {
      return;
    }
    if (selectedAssociateIndex >= filteredAssociates.length) {
      setSelectedAssociateIndex(Math.max(0, filteredAssociates.length - 1));
    }
  }, [filteredAssociates.length, selectedAssociateIndex, screen]);

  function resetAssociateState(): void {
    setSelectedAssociateIndex(0);
    setSelectedAssociatePaths(new Set());
    setAssociateSearch("");
    setAssociateSearchMode(false);
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

  async function openSelectedRoot(): Promise<void> {
    const root = filteredRoots[selectedRootIndex];
    if (!root) {
      return;
    }

    setSelectedRoot(root);
    setRememberedRootPath(root.path);
    resetAssociateState();
    setScreen("associate");
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

  async function saveSelection(): Promise<void> {
    const result = await saveWorkspaceSelection();
    if (!result) {
      return;
    }

    await completePostSaveNavigation();
    setStatus(`Saved ${result.folderCount} folder(s) to ${result.targetPath}`, "success");
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
      setScreen("associate");
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
    setScreen("roots");
    setSelectedRoot(null);
    setRootSearch("");
    setRootSearchMode(false);
    setSelectedRootIndex(findWorkspaceIndexByPath(workspaces, selectedRoot.path));
    await refreshWorkspaces();
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

    // Returning from a full-screen editor can leave stale terminal state.
    // Force a hard clear and remount cycle so OpenTUI repaints cleanly.
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

  async function openSelectedRootInEditor(): Promise<void> {
    const root = filteredRoots[selectedRootIndex];
    if (!root) {
      return;
    }

    await openRootWorkspaceInEditor(root, buildFolderObjects(root, []));
  }

  async function resolveOrCreateRootWorkspacePath(root: WorkspaceRef, foldersForCreation: FolderObject[]): Promise<string | null> {
    if (!root) {
      return null;
    }

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
    if (!root) {
      return;
    }

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

  useKeyboard((key) => {
    if (rootSearchMode && screen === "roots") {
      if (key.name === "escape" || key.name === "return") {
        setRootSearchMode(false);
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

    if (associateSearchMode && screen === "associate") {
      if (key.name === "escape" || key.name === "return") {
        setAssociateSearchMode(false);
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

    if (!pendingCopyPrefix && (key.name === "1" || key.name === "2")) {
      setPendingCopyPrefix(key.name);
      return;
    }

    if (pendingCopyPrefix) {
      const prefix = pendingCopyPrefix;
      setPendingCopyPrefix("");

      if (prefix === "1" && key.name === "y") {
        if (screen === "roots") {
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
        if (screen === "roots") {
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

    if ((key.ctrl && key.name === "c") || key.name === "q") {
      onExit();
      return;
    }
    if (isQuestionKey(key)) {
      setShowKeymaps((current) => !current);
      return;
    }
    if (key.name === "o") {
      void openConfigInEditor();
      return;
    }

    if (screen === "roots") {
      if (key.name === "j" || key.name === "down") {
        setSelectedRootIndex((current) => Math.min(current + 1, Math.max(0, filteredRoots.length - 1)));
      }
      if (key.name === "k" || key.name === "up") {
        setSelectedRootIndex((current) => Math.max(current - 1, 0));
      }
      if (key.name === "return") {
        void openSelectedRoot();
      }
      if (key.name === "r") {
        void refreshWorkspaces();
      }
      if (key.name === "c") {
        void openSelectedRootInCursor();
      }
      if (key.name === "i") {
        void openSelectedRootInEditor();
      }
      if (key.name === "y") {
        const root = filteredRoots[selectedRootIndex];
        if (root) {
          void copyRootWorkspacePath(root, buildFolderObjects(root, []));
        }
      }
      if (key.name === "slash" || key.name === "/" || key.sequence === "/") {
        setRootSearchMode(true);
      }
      if (key.name === "escape" && rootSearch) {
        setRootSearch("");
        setSelectedRootIndex(0);
      }
      return;
    }

    if (screen === "associate") {
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
        setScreen("save");
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
        setAssociateSearchMode(true);
      }
      if (key.name === "escape") {
        setScreen("roots");
        setSelectedRoot(null);
        setStatus("");
      }
      return;
    }

    if (screen === "save") {
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
        setScreen("associate");
        setStatus("");
      }
    }
  });

  if (screen === "roots") {
    return (
      <box key={`roots-screen-${renderEpoch}`} style={{ flexDirection: "column", paddingTop: 1 }}>
        <box
          border
          title="Root Workspace"
          style={{
            flexDirection: "column",
            margin: 0,
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
          }}
        >
          <text>{fitLine(`Configured groups: ${config.groups.length}`, outerLineMaxWidth)}</text>
          {rootSearchMode || rootSearch ? (
            <text>
              {fitLine(`Search: ${rootSearchMode ? "(typing...)" : ""} ${rootSearch}`.trimEnd(), outerLineMaxWidth)}
            </text>
          ) : null}
          <box
            style={{
              flexDirection: "column",
              padding: 0,
              marginTop: 1,
            }}
          >
            {visibleRoots.map((workspace, visibleIndex) => {
              const index = rootWindow.start + visibleIndex;
              return (
              <text
                key={workspace.id}
                bg={index === selectedRootIndex ? ROW_ACTIVE_BG : undefined}
                fg={index === selectedRootIndex ? ROW_ACTIVE_FG : undefined}
              >
                {fitLine(`${linePrefix(index === selectedRootIndex)} ${workspaceLabel(workspace)}`, rowMaxWidth)}
              </text>
              );
            })}
            {workspaces.length === 0 ? <text>No root workspaces available.</text> : null}
            {workspaces.length > 0 && filteredRoots.length === 0 ? <text>No root workspaces match the current search.</text> : null}
          </box>
          <text fg={messageFg}>{fitLine(isRefreshing ? "Loading workspaces..." : message, outerLineMaxWidth)}</text>
          {showKeymaps ? <KeymapLine hints={rootKeyHints} /> : null}
        </box>
      </box>
    );
  }

  if (screen === "save") {
    const total = 1 + selectedAssociates.length;

    return (
      <box key={`save-screen-${renderEpoch}`} style={{ flexDirection: "column", paddingTop: 1 }}>
        <box
          border
          title="Save Preview"
          style={{
            flexDirection: "column",
            margin: 0,
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
          }}
        >
          <text>{fitLine(`Root: ${selectedRoot ? workspaceLabel(selectedRoot) : ""}`, outerLineMaxWidth)}</text>
          <text>{fitLine(`Target: ${previewTargetPath}`, outerLineMaxWidth)}</text>
          <text>{fitLine(`Associates: ${selectedAssociates.length}`, outerLineMaxWidth)}</text>
          <text>{fitLine(`Folders to write: ${total}`, outerLineMaxWidth)}</text>
          <text>{fitLine("Confirm save?", outerLineMaxWidth)}</text>
          <box style={{ flexDirection: "column", padding: 1, marginTop: 1, flexGrow: 1 }}>
            {previewLines.map((line, index) => (
              <text key={`preview-${index}`}>{fitLine(line, previewLineMaxWidth)}</text>
            ))}
          </box>
          {selectedAssociates.length === 0 ? (
            <text fg="#f59e0b">{fitLine("Warning: no associate workspaces selected; only root workspace will be saved", outerLineMaxWidth)}</text>
          ) : null}
          <text fg={messageFg}>{fitLine(message, outerLineMaxWidth)}</text>
          {showKeymaps ? <KeymapLine hints={saveKeyHints} /> : null}
        </box>
      </box>
    );
  }

  return (
    <box key={`associate-screen-${renderEpoch}`} style={{ flexDirection: "column", paddingTop: 1 }}>
      <box
        border
        title="Associate Workspaces"
        style={{
          flexDirection: "column",
          margin: 0,
          paddingTop: 0,
          paddingRight: 0,
          paddingBottom: 0,
          paddingLeft: 0,
        }}
      >
        <text>{fitLine(selectedRoot ? workspaceLabel(selectedRoot) : "", outerLineMaxWidth)}</text>
        {associateSearchMode || associateSearch ? (
          <text>
            {fitLine(
              `Search: ${associateSearchMode ? "(typing...)" : ""} ${associateSearch}`.trimEnd(),
              outerLineMaxWidth,
            )}
          </text>
        ) : null}
        <box style={{ flexDirection: "column", padding: 0, marginTop: 1, flexGrow: 1 }}>
          {visibleAssociates.map((workspace, visibleIndex) => {
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
                rowMaxWidth,
              )}
            </text>
            );
          })}
          {associateCandidates.length === 0 ? <text>No available associates for this root.</text> : null}
          {associateCandidates.length > 0 && filteredAssociates.length === 0 ? (
            <text>No associate workspaces match the current search.</text>
          ) : null}
        </box>
        <text fg={messageFg}>{fitLine(message, outerLineMaxWidth)}</text>
        {showKeymaps ? <KeymapLine hints={associateKeyHints} /> : null}
      </box>
    </box>
  );
}

export async function runTui(): Promise<void> {
  const renderer = (await createCliRenderer({
    exitOnCtrlC: false,
  })) as { destroy: () => void };
  const root = createRoot(renderer);

  function exitTui(): void {
    root.unmount();
    renderer.destroy();
    process.stdout.write("\x1b[2J\x1b[H\x1b[0m");
  }

  root.render(<App onExit={exitTui} />);
}
