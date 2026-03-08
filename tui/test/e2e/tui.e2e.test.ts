import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFixtureContext,
  createFixtureContext,
  createWorkspaceDir,
  readLogLines,
  TmuxHarness,
  writeWorkspaceConfig,
  writeWorkspaceFile,
} from "./helpers.js";

const fixtures: Array<{
  rootDir: string;
  workspaceConfigPath: string;
  binDir: string;
  editorLogPath: string;
  cursorLogPath: string;
}> = [];
const harnesses: TmuxHarness[] = [];
const testDir = path.dirname(fileURLToPath(import.meta.url));

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixtureContext(fixture)));
});

describe("tui e2e", () => {
  it(
    "creates a new workspace file from the full TUI flow",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      const phpPath = await createWorkspaceDir(fixture.rootDir, "services/phpapp");
      await createWorkspaceDir(fixture.rootDir, "services/frontend");

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "apischeduler",
          metadata: {
            "container-debug-path": "/opt/app/.cursor/",
            "docker-service": "apischeduler",
          },
          paths: [{ name: "APISCHEDULER-BACKEND-M", path: rootPath }],
        },
        {
          group: "php",
          metadata: {
            "container-debug-path": "/data/docroot/.cursor",
            "docker-service": "app",
          },
          paths: [{ name: "PHPAPP-M", path: phpPath }],
        },
        {
          group: "frontend",
          metadata: {
            "container-debug-path": "/app/.cursor/",
            "docker-service": "frontend",
          },
          paths: [{ name: "FRONTEND-M", path: path.join(fixture.rootDir, "services/frontend") }],
        },
      ]);

      const harness = await launchHarness(fixture);
      await harness.waitForText("Root Workspace");
      await harness.waitForText("Configured groups: 3");

      harness.sendKey("Enter");
      await harness.waitForText("Associate Workspaces");
      harness.sendKey("Space");
      await harness.waitForText("[x] PHPAPP-M");
      harness.sendKey("Enter");
      await harness.waitForText("Save Preview");
      await harness.waitForText('"name": "APISCHEDULER-BACKEND-M"');
      await harness.waitForText('"name": "PHPAPP-M"');
      harness.sendKey("Enter");

      const targetWorkspacePath = path.join(rootPath, "apischeduler-backend-m.code-workspace");
      await harness.waitForText(`Saved 2 folder(s) to ${targetWorkspacePath}`);
      await harness.waitForText("Root Workspace");

      const saved = await readFile(targetWorkspacePath, "utf8");
      expect(saved).toContain('"name": "APISCHEDULER-BACKEND-M"');
      expect(saved).toContain('"name": "PHPAPP-M"');
      expect(saved).toContain('"docker-service": "apischeduler"');
      expect(saved).toContain('"docker-service": "app"');
    },
    20_000,
  );

  it(
    "reuses an existing workspace file and preserves non-folder keys",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      const phpPath = await createWorkspaceDir(fixture.rootDir, "services/phpapp");
      const existingWorkspacePath = await writeWorkspaceFile(
        rootPath,
        "apischeduler.code-workspace",
        `{
  "settings": {
    "editor.tabSize": 2
  },
  "folders": [
    {
      "name": "OLD",
      "path": "/tmp/old"
    }
  ]
}
`,
      );

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "apischeduler",
          metadata: {
            "container-debug-path": "/opt/app/.cursor/",
            "docker-service": "apischeduler",
          },
          paths: [{ name: "APISCHEDULER-BACKEND-M", path: rootPath }],
        },
        {
          group: "php",
          metadata: {
            "container-debug-path": "/data/docroot/.cursor",
            "docker-service": "app",
          },
          paths: [{ name: "PHPAPP-M", path: phpPath }],
        },
      ]);

      const harness = await launchHarness(fixture);
      await harness.waitForText("Root Workspace");
      harness.sendKey("Enter");
      await harness.waitForText("Associate Workspaces");
      harness.sendKey("Space");
      harness.sendKey("Enter");
      await harness.waitForText(`Target: ${existingWorkspacePath}`);
      harness.sendKey("Enter");

      await harness.waitForText(`Saved 2 folder(s) to ${existingWorkspacePath}`);
      const saved = await readFile(existingWorkspacePath, "utf8");
      expect(saved).toContain('"editor.tabSize": 2');
      expect(saved).toContain('"name": "APISCHEDULER-BACKEND-M"');
      expect(saved).toContain('"name": "PHPAPP-M"');
      expect(saved).not.toContain('"name": "OLD"');
    },
    20_000,
  );

  it(
    "blocks selecting a second associate from the same group",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      const phpMainPath = await createWorkspaceDir(fixture.rootDir, "services/phpapp");
      const phpWtPath = await createWorkspaceDir(fixture.rootDir, "services/phpapp--worktrees/0");

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "apischeduler",
          paths: [{ name: "APISCHEDULER-BACKEND-M", path: rootPath }],
        },
        {
          group: "php",
          paths: [
            { name: "PHPAPP-M", path: phpMainPath },
            { name: "PHPAPP-0", path: phpWtPath },
          ],
        },
      ]);

      const harness = await launchHarness(fixture);
      await harness.waitForText("Root Workspace");
      harness.sendKey("Enter");
      await harness.waitForText("Associate Workspaces");
      harness.sendKey("Space");
      await harness.waitForText("[x] PHPAPP-M");
      harness.sendKey("j");
      harness.sendKey("Space");

      await harness.waitForText("Group 'php' already has a selected workspace");
      const pane = harness.capture();
      expect(pane).toContain("[x] PHPAPP-M");
      expect(pane).toContain("[ ] PHPAPP-0");
    },
    20_000,
  );

  it(
    "keeps the user on associates when save is attempted without selections",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      const phpPath = await createWorkspaceDir(fixture.rootDir, "services/phpapp");

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "apischeduler",
          paths: [{ name: "APISCHEDULER-BACKEND-M", path: rootPath }],
        },
        {
          group: "php",
          paths: [{ name: "PHPAPP-M", path: phpPath }],
        },
      ]);

      const harness = await launchHarness(fixture);
      await harness.waitForText("Root Workspace");
      harness.sendKey("Enter");
      await harness.waitForText("Associate Workspaces");
      harness.sendKey("Enter");

      await harness.waitForText("Select at least one associate workspace before saving");
      expect(harness.capture()).toContain("Associate Workspaces");
      expect(harness.capture()).not.toContain("Save Preview");
    },
    20_000,
  );

  it(
    "stubs editor and cursor launches and returns to a valid UI state",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      const workspacePath = await writeWorkspaceFile(rootPath, "apischeduler.code-workspace", '{ "folders": [] }\n');

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "apischeduler",
          paths: [{ name: "APISCHEDULER-BACKEND-M", path: rootPath }],
        },
      ]);

      const harness = await launchHarness(fixture);
      await harness.waitForText("Root Workspace");

      harness.sendKey("o");
      await harness.waitForText(`Config opened: ${fixture.workspaceConfigPath}`);
      await harness.waitForText("Root Workspace");

      harness.sendKey("i");
      await harness.waitForText(`Inspected in editor: ${workspacePath}`);
      await harness.waitForText("Root Workspace");

      harness.sendKey("c");
      await harness.waitForText(`Opened in Cursor: ${workspacePath}`);

      const editorLogs = await readLogLines(fixture.editorLogPath);
      const cursorLogs = await readLogLines(fixture.cursorLogPath);
      expect(editorLogs).toContain(`--wait ${fixture.workspaceConfigPath}`);
      expect(editorLogs).toContain(`--wait ${workspacePath}`);
      expect(cursorLogs).toContain(workspacePath);
    },
    20_000,
  );
});

async function setupFixture() {
  const fixture = await createFixtureContext();
  fixtures.push(fixture);
  return fixture;
}

async function launchHarness(fixture: Awaited<ReturnType<typeof createFixtureContext>>) {
  const harness = await TmuxHarness.launch({
    workdir: path.resolve(testDir, "..", ".."),
    entrypoint: path.join("src", "cli", "index.ts"),
    configPath: fixture.workspaceConfigPath,
    binDir: fixture.binDir,
  });
  harnesses.push(harness);
  return harness;
}
