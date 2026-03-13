export type WorkspaceRef = {
  id: string;
  name: string;
  group: string;
  path: string;
  existsOnDisk: boolean;
  metadata: Record<string, unknown>;
};

export type FolderEntry = {
  index: number;
  path: string;
  absolutePath: string;
  name?: string;
  containerDebugPath?: string;
  existsOnDisk: boolean;
  isSelected: boolean;
};

export type WorkspaceDoc = {
  rawText: string;
  parsed: Record<string, unknown>;
  folders: FolderEntry[];
};

export type SavePlan = {
  workspacePath: string;
  selectedIndexes: number[];
  createBackup: boolean;
};

export type ValidationResult = {
  ok: boolean;
  diagnostics: string[];
};

export type UserConfig = {
  groups: WorkspaceGroup[];
};

export type FolderLike = {
  path: string;
  name?: string;
  [key: string]: unknown;
};

export type WorkspacePathConfig = {
  path: string;
  name: string;
};

export type WorkspaceGroup = {
  group: string;
  paths: WorkspacePathConfig[];
  "env-export-file"?: string;
  [key: string]: unknown;
};
