export { loadConfig, defaultConfig } from "./config/config.js";
export { discoverWorkspaces } from "./io/discovery.js";
export {
  applyMcpMutation,
  buildMcpMutationPreview,
  computeVendorTemplateDiffs,
  listMcpTemplates,
  loadMcpVendorConfigs,
} from "./io/mcp.js";
export { loadWorkspace, validateWorkspace, applySelection } from "./io/workspace.js";
export type { WorkspaceRef, WorkspaceDoc, FolderEntry, SavePlan, UserConfig } from "./domain/types.js";
