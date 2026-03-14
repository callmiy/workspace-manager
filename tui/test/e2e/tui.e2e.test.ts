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
    "allows save preview without associates and shows a warning",
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

      await harness.waitForText("Save Preview");
      await harness.waitForText("Associates: 0");
      await harness.waitForText("Folders to write: 1");
      await harness.waitForText("Warning: no associate workspaces selected; only root workspace will be saved");
    },
    20_000,
  );

  it(
    "preselects associates already present in the existing workspace file",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      const phpPath = await createWorkspaceDir(fixture.rootDir, "services/phpapp");
      const frontendPath = await createWorkspaceDir(fixture.rootDir, "services/frontend");

      await writeWorkspaceFile(
        rootPath,
        "apischeduler.code-workspace",
        `{
  "folders": [
    {
      "name": "APISCHEDULER-BACKEND-M",
      "path": ${JSON.stringify(rootPath)}
    },
    {
      "name": "PHPAPP-M",
      "path": ${JSON.stringify(phpPath)}
    },
    {
      "name": "LEGACY",
      "path": "/tmp/legacy"
    }
  ]
}
`,
      );

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "apischeduler",
          paths: [{ name: "APISCHEDULER-BACKEND-M", path: rootPath }],
        },
        {
          group: "php",
          paths: [{ name: "PHPAPP-M", path: phpPath }],
        },
        {
          group: "frontend",
          paths: [{ name: "FRONTEND-M", path: frontendPath }],
        },
      ]);

      const harness = await launchHarness(fixture);
      await harness.waitForText("Root Workspace");
      harness.sendKey("Enter");
      await harness.waitForText("Associate Workspaces");
      await harness.waitForText("[x] PHPAPP-M");

      const pane = harness.capture();
      expect(pane).toContain("[x] PHPAPP-M");
      expect(pane).toContain("[ ] FRONTEND-M");
      expect(pane).not.toContain("LEGACY");
    },
    20_000,
  );

  it(
    "opens associate workspaces with no preselection when the existing workspace file is invalid",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      const phpPath = await createWorkspaceDir(fixture.rootDir, "services/phpapp");

      await writeWorkspaceFile(rootPath, "apischeduler.code-workspace", '{"folders": [}\n');

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
      await harness.waitForText("Failed to preload associates from existing workspace:");

      const pane = harness.capture();
      expect(pane).toContain("[ ] PHPAPP-M");
      expect(pane).not.toContain("[x] PHPAPP-M");
    },
    20_000,
  );

  it(
    "returns to the originally selected root after saving",
    async () => {
      const fixture = await setupFixture();
      const alphaRootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      const betaRootPath = await createWorkspaceDir(fixture.rootDir, "services/phpapp");
      await createWorkspaceDir(fixture.rootDir, "services/frontend");

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "alpha",
          paths: [{ name: "ALPHA-M", path: alphaRootPath }],
        },
        {
          group: "beta",
          paths: [{ name: "BETA-M", path: betaRootPath }],
        },
        {
          group: "frontend",
          paths: [{ name: "FRONTEND-M", path: path.join(fixture.rootDir, "services/frontend") }],
        },
      ]);

      const harness = await launchHarness(fixture);
      await harness.waitForText("Root Workspace");
      harness.sendKey("j");
      await harness.waitForText("> BETA-M: ");
      harness.sendKey("Enter");
      await harness.waitForText("Associate Workspaces");
      harness.sendKey("Enter");
      await harness.waitForText("Save Preview");
      harness.sendKey("Enter");

      const targetWorkspacePath = path.join(betaRootPath, "beta-m.code-workspace");
      await harness.waitForText(`Saved 1 folder(s) to ${targetWorkspacePath}`);
      await harness.waitForText("Root Workspace");
      expect(harness.capture()).toContain("> BETA-M: ");
    },
    20_000,
  );

  it(
    "returns to the originally selected root after backing out from save preview",
    async () => {
      const fixture = await setupFixture();
      const alphaRootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      const betaRootPath = await createWorkspaceDir(fixture.rootDir, "services/phpapp");
      await createWorkspaceDir(fixture.rootDir, "services/frontend");

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "alpha",
          paths: [{ name: "ALPHA-M", path: alphaRootPath }],
        },
        {
          group: "beta",
          paths: [{ name: "BETA-M", path: betaRootPath }],
        },
        {
          group: "frontend",
          paths: [{ name: "FRONTEND-M", path: path.join(fixture.rootDir, "services/frontend") }],
        },
      ]);

      const harness = await launchHarness(fixture);
      await harness.waitForText("Root Workspace");
      harness.sendKey("j");
      await harness.waitForText("> BETA-M: ");
      harness.sendKey("Enter");
      await harness.waitForText("Associate Workspaces");
      harness.sendKey("Enter");
      await harness.waitForText("Save Preview");
      harness.sendKey("Escape");
      await harness.waitForText("Associate Workspaces");
      harness.sendKey("Escape");
      await harness.waitForText("Root Workspace");
      expect(harness.capture()).toContain("> BETA-M: ");
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

  it(
    "uses parent nvim remote open when running inside nvim and editor is nvim-family",
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

      const harness = await TmuxHarness.launch({
        workdir: path.resolve(testDir, "..", ".."),
        entrypoint: path.join("src", "cli", "index.ts"),
        configPath: fixture.workspaceConfigPath,
        binDir: fixture.binDir,
        editorCommand: "nvim",
        nvimServer: "/tmp/nvim-parent.sock",
      });
      harnesses.push(harness);

      await harness.waitForText("Root Workspace");

      harness.sendKey("o");
      await harness.waitForText(`Config opened: ${fixture.workspaceConfigPath}`);
      await harness.waitForText("Root Workspace");

      harness.sendKey("i");
      await harness.waitForText(`Inspected in editor: ${workspacePath}`);
      await harness.waitForText("Root Workspace");

      const nvimLogs = await readLogLines(fixture.nvimLogPath);
      expect(nvimLogs).toContain(`--server /tmp/nvim-parent.sock --remote ${fixture.workspaceConfigPath}`);
      expect(nvimLogs).toContain(`--server /tmp/nvim-parent.sock --remote ${workspacePath}`);
    },
    20_000,
  );

  it(
    "injects resolved env exports when opening Cursor from a root workspace",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler--worktrees/0");
      const envFile = await writeWorkspaceFile(
        fixture.rootDir,
        "scripts/.scratch-env-apischeduler.sh",
        `#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# WORKSPACE MANAGER COPY ENVIRONMENT VARIABLES
# -----------------------------------------------------------------------------
export API_SCHEDULER_GIT_ROOT="$(pwd)"
export PYTHON_BIN="$API_SCHEDULER_GIT_ROOT/.venv/bin/python"
export EBNIS_LINT_CMDS="bash $API_SCHEDULER_GIT_ROOT/lint.sh"
# -----------------------------------------------------------------------------
# /END/ WORKSPACE MANAGER COPY ENVIRONMENT VARIABLES
# -----------------------------------------------------------------------------
`,
      );
      const workspacePath = await writeWorkspaceFile(rootPath, "apischeduler.code-workspace", '{ "folders": [] }\n');

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "apischeduler",
          metadata: {
            "env-export-file": envFile,
          },
          paths: [{ name: "APISCHEDULER-BACKEND-0", path: rootPath }],
        },
      ]);

      const harness = await TmuxHarness.launch({
        workdir: path.resolve(testDir, "..", ".."),
        entrypoint: path.join("src", "cli", "index.ts"),
        configPath: fixture.workspaceConfigPath,
        binDir: fixture.binDir,
        stubEnvKeys: ["API_SCHEDULER_GIT_ROOT", "PYTHON_BIN", "EBNIS_LINT_CMDS"],
      });
      harnesses.push(harness);

      await harness.waitForText("Root Workspace");
      harness.sendKey("c");
      await harness.waitForText(`Opened in Cursor: ${workspacePath}`);

      const cursorLogs = await readLogLines(fixture.cursorLogPath);
      const cursorEnvLogs = await readLogLines(fixture.cursorEnvLogPath);
      expect(cursorLogs).toContain(workspacePath);
      expect(cursorEnvLogs).toContain(`API_SCHEDULER_GIT_ROOT=${rootPath}`);
      expect(cursorEnvLogs).toContain(`PYTHON_BIN=${path.join(rootPath, ".venv", "bin", "python")}`);
      expect(cursorEnvLogs).toContain(`EBNIS_LINT_CMDS=bash ${path.join(rootPath, "lint.sh")}`);
    },
    20_000,
  );

  it(
    "blocks opening Cursor when env-export-file resolution fails",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
      await writeWorkspaceFile(rootPath, "apischeduler.code-workspace", '{ "folders": [] }\n');
      const envFile = await writeWorkspaceFile(
        fixture.rootDir,
        "scripts/.scratch-env-apischeduler.sh",
        `#!/usr/bin/env bash
export FOO=bar
`,
      );

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "apischeduler",
          metadata: {
            "env-export-file": envFile,
          },
          paths: [{ name: "APISCHEDULER-BACKEND-M", path: rootPath }],
        },
      ]);

      const harness = await TmuxHarness.launch({
        workdir: path.resolve(testDir, "..", ".."),
        entrypoint: path.join("src", "cli", "index.ts"),
        configPath: fixture.workspaceConfigPath,
        binDir: fixture.binDir,
        stubEnvKeys: ["FOO"],
      });
      harnesses.push(harness);

      await harness.waitForText("Root Workspace");
      harness.sendKey("c");
      await harness.waitForText("Cannot open in Cursor: Error: Missing start marker");

      const cursorLogs = await readLogLines(fixture.cursorLogPath);
      expect(cursorLogs).toHaveLength(0);
    },
    20_000,
  );

  it(
    "auto-detects .venv and launches Cursor in that virtualenv context",
    async () => {
      const fixture = await setupFixture();
      const rootPath = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler--worktrees/0");
      await createWorkspaceDir(fixture.rootDir, "services/api.scheduler--worktrees/0/.venv/bin");
      await writeWorkspaceFile(rootPath, ".venv/bin/python", "#!/usr/bin/env bash\n",);
      const workspacePath = await writeWorkspaceFile(rootPath, "apischeduler.code-workspace", '{ "folders": [] }\n');

      await writeWorkspaceConfig(fixture.workspaceConfigPath, [
        {
          group: "apischeduler",
          paths: [{ name: "APISCHEDULER-BACKEND-0", path: rootPath }],
        },
      ]);

      const harness = await TmuxHarness.launch({
        workdir: path.resolve(testDir, "..", ".."),
        entrypoint: path.join("src", "cli", "index.ts"),
        configPath: fixture.workspaceConfigPath,
        binDir: fixture.binDir,
        stubEnvKeys: ["VIRTUAL_ENV", "PATH"],
      });
      harnesses.push(harness);

      await harness.waitForText("Root Workspace");
      harness.sendKey("c");
      await harness.waitForText(`Opened in Cursor: ${workspacePath}`);

      const cursorLogs = await readLogLines(fixture.cursorLogPath);
      const cursorEnvLogs = await readLogLines(fixture.cursorEnvLogPath);
      expect(cursorLogs).toContain(workspacePath);
      expect(cursorEnvLogs).toContain(`VIRTUAL_ENV=${path.join(rootPath, ".venv")}`);
      const pathLine = cursorEnvLogs.find((line) => line.startsWith("PATH="));
      expect(pathLine).toBeDefined();
      expect(pathLine?.startsWith(`PATH=${path.join(rootPath, ".venv", "bin")}:`)).toBe(true);
      expect(pathLine).toContain(`:${fixture.binDir}:`);
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
