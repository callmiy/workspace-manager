export { loadConfig, defaultConfig } from "./config/config.js";
export { discoverWorkspaces } from "./io/discovery.js";
export { loadWorkspace, validateWorkspace, applySelection } from "./io/workspace.js";
export type { WorkspaceRef, WorkspaceDoc, FolderEntry, SavePlan, UserConfig } from "./domain/types.js";
