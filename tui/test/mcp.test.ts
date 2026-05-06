import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCP_TEMPLATE_ROOT_ENV,
  applyMcpMutation,
  buildMcpMutationPreview,
  computeVendorTemplateDiffs,
  listMcpTemplates,
  loadMcpVendorConfigs,
} from "../src/io/mcp.js";

const tmpDirs: string[] = [];
const originalTemplateRoot = process.env[MCP_TEMPLATE_ROOT_ENV];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  if (typeof originalTemplateRoot === "string") {
    process.env[MCP_TEMPLATE_ROOT_ENV] = originalTemplateRoot;
  } else {
    delete process.env[MCP_TEMPLATE_ROOT_ENV];
  }
});

describe("mcp IO", () => {
  it("loads templates from MCP_TEMPLATE_ROOT with JSONC comments", async () => {
    const fixture = await setupFixture();
    await writeFile(
      path.join(fixture.templateRoot, "browser.json"),
      `{
  // comment
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["browser-mcp"]
    }
  }
}
`,
      "utf8",
    );

    const templates = await listMcpTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toBe("browser");
    expect(templates[0]?.serverKeys).toEqual(["browser"]);
  });

  it("computes diff state and applies add/update/remove preview semantics", async () => {
    const fixture = await setupFixture();
    await writeFile(
      path.join(fixture.templateRoot, "browser.json"),
      JSON.stringify(
        {
          mcpServers: {
            browser: { command: "npx", args: ["browser-mcp"] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      path.join(fixture.templateRoot, "figma.json"),
      JSON.stringify(
        {
          mcpServers: {
            figma: { command: "npx", args: ["figma-mcp"] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await mkdir(path.join(fixture.projectRoot, ".cursor"), { recursive: true });
    await writeFile(
      path.join(fixture.projectRoot, ".cursor/mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            browser: { command: "old", args: [] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const templates = await listMcpTemplates();
    const vendorConfigs = await loadMcpVendorConfigs(fixture.projectRoot);
    const diffs = computeVendorTemplateDiffs(templates, vendorConfigs);
    const browserDiff = diffs.find((entry) => entry.templateName === "browser");
    expect(browserDiff?.vendors.find((entry) => entry.vendor === "cursor")?.missingKeys).toEqual([]);
    const figmaDiff = diffs.find((entry) => entry.templateName === "figma");
    expect(figmaDiff?.vendors.find((entry) => entry.vendor === "cursor")?.missingKeys).toEqual(["figma"]);

    const addPreview = buildMcpMutationPreview({
      action: "add",
      projectRoot: fixture.projectRoot,
      templates,
      vendorConfigs,
      vendorScope: "selected",
      selectedVendor: "cursor",
      templateScope: "selected",
      selectedTemplate: "figma",
    });
    expect(addPreview.operations[0]?.changedKeys).toEqual(["figma"]);
    await applyMcpMutation(addPreview);

    const afterAdd = JSON.parse(await readFile(path.join(fixture.projectRoot, ".cursor/mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(afterAdd.mcpServers).sort()).toEqual(["browser", "figma"]);

    const updatePreview = buildMcpMutationPreview({
      action: "update",
      projectRoot: fixture.projectRoot,
      templates,
      vendorConfigs: await loadMcpVendorConfigs(fixture.projectRoot),
      vendorScope: "selected",
      selectedVendor: "cursor",
      templateScope: "selected",
      selectedTemplate: "browser",
    });
    expect(updatePreview.operations[0]?.changedKeys).toEqual(["browser"]);

    const removePreview = buildMcpMutationPreview({
      action: "remove",
      projectRoot: fixture.projectRoot,
      templates,
      vendorConfigs: await loadMcpVendorConfigs(fixture.projectRoot),
      vendorScope: "all",
      selectedVendor: "cursor",
      templateScope: "selected",
      selectedTemplate: "browser",
    });
    expect(removePreview.operations.map((entry) => entry.vendor)).toEqual(["claude", "cursor", "gemini"]);
    expect(removePreview.operations.find((entry) => entry.vendor === "claude")?.willInitialize).toBe(true);
    await applyMcpMutation(removePreview);

    const cursorAfterRemove = JSON.parse(await readFile(path.join(fixture.projectRoot, ".cursor/mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cursorAfterRemove.mcpServers)).toEqual(["figma"]);

    const claudeAfterRemove = JSON.parse(await readFile(path.join(fixture.projectRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(claudeAfterRemove.mcpServers).toEqual({});
  });
});

async function setupFixture(): Promise<{ root: string; templateRoot: string; projectRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wks-mcp-"));
  tmpDirs.push(root);
  const templateRoot = path.join(root, "templates");
  const projectRoot = path.join(root, "project");
  await mkdir(templateRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  process.env[MCP_TEMPLATE_ROOT_ENV] = templateRoot;
  return { root, templateRoot, projectRoot };
}
