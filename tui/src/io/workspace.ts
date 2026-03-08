import { access, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { FolderEntry, FolderLike, SavePlan, ValidationResult, WorkspaceDoc } from "../domain/types.js";

export type WorkspaceFolderWriteEntry = {
  name: string;
  path: string;
  metadata?: Record<string, unknown>;
};

function buildUniqueTempPath(workspacePath: string): string {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return `${workspacePath}.tmp.${nonce}`;
}

function getParseDiagnostics(errors: ParseError[]): string[] {
  return errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`);
}

const JSONC_PARSE_OPTIONS = {
  allowTrailingComma: true,
  disallowComments: false,
  allowEmptyContent: false,
} as const;

function toAbsolutePath(workspacePath: string, folderPath: string): string {
  if (path.isAbsolute(folderPath)) {
    return folderPath;
  }
  return path.resolve(path.dirname(workspacePath), folderPath);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertValidJsonc(text: string, context: string): Promise<void> {
  const errors: ParseError[] = [];
  parse(text, errors, JSONC_PARSE_OPTIONS);
  if (errors.length > 0) {
    throw new Error(`${context}: ${getParseDiagnostics(errors).join("; ")}`);
  }
}

async function atomicWrite(workspacePath: string, content: string): Promise<void> {
  const tmpPath = buildUniqueTempPath(workspacePath);
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, workspacePath);
  } finally {
    if (await pathExists(tmpPath)) {
      await unlink(tmpPath).catch(() => {
        // Best-effort cleanup for failed/aborted writes.
      });
    }
  }
}

function normalizeFolders(workspacePath: string, folders: unknown[]): Promise<FolderEntry[]> {
  const normalized: FolderEntry[] = [];

  folders.forEach((value, index) => {
    if (!value || typeof value !== "object") {
      return;
    }

    const folder = value as FolderLike;
    if (typeof folder.path !== "string") {
      return;
    }

    const absolutePath = toAbsolutePath(workspacePath, folder.path);
    normalized.push({
      index,
      path: folder.path,
      absolutePath,
      name: typeof folder.name === "string" ? folder.name : undefined,
      containerDebugPath:
        typeof folder["container-debug-path"] === "string" ? (folder["container-debug-path"] as string) : undefined,
      existsOnDisk: false,
      isSelected: true,
    });
  });

  return Promise.all(
    normalized.map(async (folder) => ({
      ...folder,
      existsOnDisk: await pathExists(folder.absolutePath),
    })),
  );
}

export async function loadWorkspace(workspacePath: string): Promise<WorkspaceDoc> {
  const resolvedPath = path.resolve(workspacePath);
  const rawText = await readFile(resolvedPath, "utf8");
  const errors: ParseError[] = [];
  const parsed = parse(rawText, errors, JSONC_PARSE_OPTIONS) as Record<string, unknown>;

  if (errors.length > 0) {
    const diagnostics = getParseDiagnostics(errors).join("; ");
    throw new Error(`Failed to parse workspace JSONC: ${diagnostics}`);
  }

  const foldersValue = Array.isArray(parsed?.folders) ? parsed.folders : [];
  const folders = await normalizeFolders(resolvedPath, foldersValue);

  return { rawText, parsed, folders };
}

export async function validateWorkspace(workspacePath: string): Promise<ValidationResult> {
  const diagnostics: string[] = [];
  const resolvedPath = path.resolve(workspacePath);

  try {
    await stat(resolvedPath);
  } catch {
    return {
      ok: false,
      diagnostics: [`Workspace not found: ${resolvedPath}`],
    };
  }

  const rawText = await readFile(resolvedPath, "utf8");
  const parseErrors: ParseError[] = [];
  const parsed = parse(rawText, parseErrors, JSONC_PARSE_OPTIONS) as Record<string, unknown>;

  if (parseErrors.length > 0) {
    diagnostics.push(...getParseDiagnostics(parseErrors));
    return { ok: false, diagnostics };
  }

  const foldersValue = Array.isArray(parsed?.folders) ? parsed.folders : [];
  const folders = await normalizeFolders(resolvedPath, foldersValue);

  const missing = folders.filter((folder) => !folder.existsOnDisk);
  if (missing.length > 0) {
    diagnostics.push(...missing.map((folder) => `Missing path: ${folder.absolutePath}`));
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
  };
}

function buildNextFolders(parsed: Record<string, unknown>, selectedIndexes: Set<number>): unknown[] {
  const folders = Array.isArray(parsed.folders) ? parsed.folders : [];
  return folders.filter((_, index) => selectedIndexes.has(index));
}

export async function applySelection(plan: SavePlan): Promise<void> {
  const workspacePath = path.resolve(plan.workspacePath);
  const rawText = await readFile(workspacePath, "utf8");
  const parseErrors: ParseError[] = [];
  const parsed = parse(rawText, parseErrors, JSONC_PARSE_OPTIONS) as Record<string, unknown>;

  if (parseErrors.length > 0) {
    throw new Error(`Cannot save invalid JSONC workspace: ${getParseDiagnostics(parseErrors).join("; ")}`);
  }

  const selected = new Set(plan.selectedIndexes);
  const nextFolders = buildNextFolders(parsed, selected);

  const edits = modify(rawText, ["folders"], nextFolders, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
      eol: "\n",
    },
    getInsertionIndex: () => 0,
  });

  const nextText = applyEdits(rawText, edits);
  await assertValidJsonc(nextText, "Write produced invalid JSONC");

  if (plan.createBackup) {
    const backupPath = `${workspacePath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(workspacePath, backupPath);
  }

  await mkdir(path.dirname(workspacePath), { recursive: true });
  await atomicWrite(workspacePath, nextText);
}

function toWorkspaceFolder(entry: WorkspaceFolderWriteEntry): Record<string, unknown> {
  const folder: Record<string, unknown> = {
    name: entry.name,
    path: entry.path,
  };

  if (entry.metadata) {
    Object.entries(entry.metadata).forEach(([key, value]) => {
      folder[key] = value;
    });
  }

  return folder;
}

async function listWorkspaceFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".code-workspace"))
      .map((entry) => path.resolve(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  } catch {
    return [];
  }
}

export async function resolveWorkspaceTarget(rootWorkspacePath: string): Promise<string | null> {
  const root = path.resolve(rootWorkspacePath);
  const rootMatches = await listWorkspaceFiles(root);
  if (rootMatches.length > 0) {
    return rootMatches[0] ?? null;
  }

  const vscodeMatches = await listWorkspaceFiles(path.join(root, ".vscode"));
  return vscodeMatches[0] ?? null;
}

export async function writeWorkspaceFolders(
  targetWorkspacePath: string,
  folders: WorkspaceFolderWriteEntry[],
  createBackup: boolean,
): Promise<void> {
  const workspacePath = path.resolve(targetWorkspacePath);
  const folderObjects = folders.map(toWorkspaceFolder);

  const exists = await pathExists(workspacePath);
  if (!exists) {
    const content = `${JSON.stringify({ folders: folderObjects }, null, 2)}\n`;
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await writeFile(workspacePath, content, "utf8");
    return;
  }

  const rawText = await readFile(workspacePath, "utf8");
  const parseErrors: ParseError[] = [];
  parse(rawText, parseErrors, JSONC_PARSE_OPTIONS);
  if (parseErrors.length > 0) {
    throw new Error(`Cannot save invalid JSONC workspace: ${getParseDiagnostics(parseErrors).join("; ")}`);
  }

  const edits = modify(rawText, ["folders"], folderObjects, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
      eol: "\n",
    },
    getInsertionIndex: () => 0,
  });
  const nextText = applyEdits(rawText, edits);
  await assertValidJsonc(nextText, "Write produced invalid JSONC");

  if (createBackup) {
    const backupPath = `${workspacePath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(workspacePath, backupPath);
  }

  await mkdir(path.dirname(workspacePath), { recursive: true });
  await atomicWrite(workspacePath, nextText);
}
