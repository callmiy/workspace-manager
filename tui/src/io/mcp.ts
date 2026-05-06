import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export const MCP_TEMPLATE_ROOT_ENV = "MCP_TEMPLATE_ROOT";
export const DEFAULT_MCP_TEMPLATE_ROOT = path.join(os.homedir(), "dotfiles", "llm-templates", "mcps");

export const MCP_VENDORS = [
  { vendor: "claude", relativePath: ".mcp.json" },
  { vendor: "cursor", relativePath: ".cursor/mcp.json" },
  { vendor: "gemini", relativePath: ".gemini/settings.json" },
] as const;

export type McpVendorName = (typeof MCP_VENDORS)[number]["vendor"];
export type McpMutationAction = "add" | "update" | "remove";

export type McpTemplateDoc = {
  name: string;
  filePath: string;
  rawText: string;
  servers: Record<string, unknown>;
  serverKeys: string[];
  previewLines: string[];
};

export type McpVendorConfig = {
  vendor: McpVendorName;
  filePath: string;
  exists: boolean;
  diagnostics: string[];
  rawText: string | null;
  parsed: Record<string, unknown>;
  mcpServers: Record<string, unknown>;
  serverKeys: string[];
};

export type McpDiffSummary = {
  templateName: string;
  vendors: Array<{
    vendor: McpVendorName;
    presentKeys: string[];
    missingKeys: string[];
  }>;
};

export type McpMutationPreview = {
  action: McpMutationAction;
  projectRoot: string;
  vendorNames: McpVendorName[];
  templateNames: string[];
  operations: Array<{
    vendor: McpVendorName;
    filePath: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    changedKeys: string[];
    willInitialize: boolean;
  }>;
};

function pathExists(targetPath: string): Promise<boolean> {
  return access(targetPath).then(
    () => true,
    () => false,
  );
}

function formatParseErrors(errors: ParseError[]): string[] {
  return errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`);
}

function parseJsoncObject(rawText: string, context: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(rawText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });

  if (errors.length > 0) {
    throw new Error(`${context}: ${formatParseErrors(errors).join("; ")}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${context}: expected JSON object`);
  }

  return parsed as Record<string, unknown>;
}

function previewLinesForJson(rawText: string): string[] {
  const lines = rawText.split("\n");
  if (lines.length <= 20) {
    return lines;
  }
  return [...lines.slice(0, 19), `… (${lines.length - 19} more lines)`];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildUniqueTempPath(targetPath: string): string {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return `${targetPath}.tmp.${nonce}`;
}

async function atomicWriteJson(targetPath: string, value: Record<string, unknown>): Promise<void> {
  const tmpPath = buildUniqueTempPath(targetPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmpPath, targetPath);
  } finally {
    if (await pathExists(tmpPath)) {
      await unlink(tmpPath).catch(() => {
        // Best-effort cleanup.
      });
    }
  }
}

function resolveTemplateRoot(): string {
  const root = process.env[MCP_TEMPLATE_ROOT_ENV]?.trim();
  return path.resolve(root && root.length > 0 ? root : DEFAULT_MCP_TEMPLATE_ROOT);
}

function resolveVendorPath(projectRoot: string, vendor: McpVendorName): string {
  const descriptor = MCP_VENDORS.find((item) => item.vendor === vendor);
  if (!descriptor) {
    throw new Error(`Unknown MCP vendor: ${vendor}`);
  }
  return path.join(path.resolve(projectRoot), descriptor.relativePath);
}

export async function listMcpTemplates(): Promise<McpTemplateDoc[]> {
  const templateRoot = resolveTemplateRoot();
  const exists = await pathExists(templateRoot);
  if (!exists) {
    throw new Error(`Template root missing: ${templateRoot}`);
  }

  const entries = await import("node:fs/promises").then((fs) => fs.readdir(templateRoot, { withFileTypes: true }));
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(templateRoot, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const templates = await Promise.all(
    files.map(async (filePath) => {
      const rawText = await readFile(filePath, "utf8");
      const parsed = parseJsoncObject(rawText, `Invalid template ${filePath}`);
      const rawServers = parsed.mcpServers;
      const servers =
        rawServers && typeof rawServers === "object" && !Array.isArray(rawServers) ? (rawServers as Record<string, unknown>) : {};
      return {
        name: path.basename(filePath, ".json"),
        filePath,
        rawText,
        servers,
        serverKeys: Object.keys(servers).sort(),
        previewLines: previewLinesForJson(rawText),
      };
    }),
  );

  return templates;
}

export async function loadMcpVendorConfigs(projectRoot: string): Promise<McpVendorConfig[]> {
  return Promise.all(
    MCP_VENDORS.map(async ({ vendor }) => {
      const filePath = resolveVendorPath(projectRoot, vendor);
      const exists = await pathExists(filePath);
      if (!exists) {
        return {
          vendor,
          filePath,
          exists: false,
          diagnostics: [],
          rawText: null,
          parsed: {},
          mcpServers: {},
          serverKeys: [],
        };
      }

      const rawText = await readFile(filePath, "utf8");
      const parseErrors: ParseError[] = [];
      const parsed = parse(rawText, parseErrors, {
        allowTrailingComma: true,
        disallowComments: false,
        allowEmptyContent: false,
      });

      if (parseErrors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          vendor,
          filePath,
          exists: true,
          diagnostics:
            parseErrors.length > 0 ? formatParseErrors(parseErrors) : ["Config root must be a JSON object"],
          rawText,
          parsed: {},
          mcpServers: {},
          serverKeys: [],
        };
      }

      const parsedObject = parsed as Record<string, unknown>;
      const rawServers = parsedObject.mcpServers;
      const mcpServers =
        rawServers && typeof rawServers === "object" && !Array.isArray(rawServers) ? (rawServers as Record<string, unknown>) : {};

      return {
        vendor,
        filePath,
        exists: true,
        diagnostics: [],
        rawText,
        parsed: parsedObject,
        mcpServers,
        serverKeys: Object.keys(mcpServers).sort(),
      };
    }),
  );
}

export function computeVendorTemplateDiffs(
  templates: McpTemplateDoc[],
  vendorConfigs: McpVendorConfig[],
): McpDiffSummary[] {
  return templates.map((template) => ({
    templateName: template.name,
    vendors: vendorConfigs.map((vendorConfig) => {
      const presentKeys = template.serverKeys.filter((key) => vendorConfig.serverKeys.includes(key));
      const missingKeys = template.serverKeys.filter((key) => !vendorConfig.serverKeys.includes(key));
      return {
        vendor: vendorConfig.vendor,
        presentKeys,
        missingKeys,
      };
    }),
  }));
}

function aggregateTemplateServers(templates: McpTemplateDoc[]): Record<string, unknown> {
  const aggregate: Record<string, unknown> = {};
  templates.forEach((template) => {
    Object.entries(template.servers).forEach(([key, value]) => {
      aggregate[key] = cloneJson(value);
    });
  });
  return aggregate;
}

function resolveVendorConfigs(
  vendorConfigs: McpVendorConfig[],
  projectRoot: string,
  vendorScope: "selected" | "all",
  selectedVendor: McpVendorName,
): McpVendorConfig[] {
  if (vendorScope === "all") {
    return vendorConfigs.length > 0
      ? vendorConfigs
      : MCP_VENDORS.map(({ vendor }) => ({
          vendor,
          filePath: resolveVendorPath(projectRoot, vendor),
          exists: false,
          diagnostics: [],
          rawText: null,
          parsed: {},
          mcpServers: {},
          serverKeys: [],
        }));
  }

  const existing = vendorConfigs.find((config) => config.vendor === selectedVendor);
  if (existing) {
    return [existing];
  }

  return [
    {
      vendor: selectedVendor,
      filePath: resolveVendorPath(projectRoot, selectedVendor),
      exists: false,
      diagnostics: [],
      rawText: null,
      parsed: {},
      mcpServers: {},
      serverKeys: [],
    },
  ];
}

function resolveTemplates(
  templates: McpTemplateDoc[],
  templateScope: "selected" | "all",
  selectedTemplate: string,
): McpTemplateDoc[] {
  if (templateScope === "all") {
    return templates;
  }
  return templates.filter((template) => template.name === selectedTemplate);
}

export function buildMcpMutationPreview(input: {
  action: McpMutationAction;
  projectRoot: string;
  templates: McpTemplateDoc[];
  vendorConfigs: McpVendorConfig[];
  vendorScope: "selected" | "all";
  selectedVendor: McpVendorName;
  templateScope: "selected" | "all";
  selectedTemplate: string;
}): McpMutationPreview {
  const templateSelection = resolveTemplates(input.templates, input.templateScope, input.selectedTemplate);
  const vendorSelection = resolveVendorConfigs(
    input.vendorConfigs,
    input.projectRoot,
    input.vendorScope,
    input.selectedVendor,
  );
  const aggregate = aggregateTemplateServers(templateSelection);
  const templateKeys = Object.keys(aggregate).sort();

  const operations = vendorSelection.map((vendorConfig) => {
    const parsed =
      vendorConfig.exists && vendorConfig.diagnostics.length === 0 ? cloneJson(vendorConfig.parsed) : { mcpServers: {} };
    const before =
      parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
        ? cloneJson(parsed.mcpServers as Record<string, unknown>)
        : {};
    const after = cloneJson(before);
    const changedKeys = new Set<string>();

    if (input.action === "remove") {
      templateKeys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(after, key)) {
          delete after[key];
          changedKeys.add(key);
        }
      });
    } else if (input.action === "add") {
      Object.entries(aggregate).forEach(([key, value]) => {
        if (!Object.prototype.hasOwnProperty.call(after, key)) {
          after[key] = cloneJson(value);
          changedKeys.add(key);
        }
      });
    } else {
      Object.entries(aggregate).forEach(([key, value]) => {
        after[key] = cloneJson(value);
        changedKeys.add(key);
      });
    }

    return {
      vendor: vendorConfig.vendor,
      filePath: vendorConfig.filePath,
      before,
      after,
      changedKeys: [...changedKeys].sort(),
      willInitialize: !vendorConfig.exists || vendorConfig.diagnostics.length > 0,
    };
  });

  return {
    action: input.action,
    projectRoot: path.resolve(input.projectRoot),
    vendorNames: operations.map((operation) => operation.vendor),
    templateNames: templateSelection.map((template) => template.name),
    operations,
  };
}

export async function applyMcpMutation(preview: McpMutationPreview): Promise<{
  action: McpMutationAction;
  updatedVendors: McpVendorName[];
}> {
  for (const operation of preview.operations) {
    const existing = (await pathExists(operation.filePath)) ? await readFile(operation.filePath, "utf8") : null;
    let parsedRoot: Record<string, unknown>;

    if (!existing) {
      parsedRoot = { mcpServers: {} };
    } else {
      try {
        parsedRoot = parseJsoncObject(existing, `Invalid vendor config ${operation.filePath}`);
      } catch {
        parsedRoot = { mcpServers: {} };
      }
    }

    parsedRoot.mcpServers = operation.after;
    await atomicWriteJson(operation.filePath, parsedRoot);
  }

  return {
    action: preview.action,
    updatedVendors: preview.operations.map((operation) => operation.vendor),
  };
}
