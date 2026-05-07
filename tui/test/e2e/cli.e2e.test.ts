import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFixtureContext,
  createFixtureContext,
  createWorkspaceDir,
  runCliCommand,
  writeWorkspaceConfig,
  writeWorkspaceFile,
} from "./helpers.js";

const fixtures: Array<Awaited<ReturnType<typeof createFixtureContext>>> = [];
const testDir = path.dirname(fileURLToPath(import.meta.url));
const tuiDir = path.resolve(testDir, "..", "..");
const entrypoint = path.join("src", "cli", "index.ts");

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixtureContext(fixture)));
});

describe("cli e2e", () => {
  it("prints the version for both -v and --version", async () => {
    const fixture = await setupFixture();

    const shortResult = runCliCommand({
      workdir: tuiDir,
      entrypoint,
      configPath: fixture.workspaceConfigPath,
      args: ["-v"],
    });
    const longResult = runCliCommand({
      workdir: tuiDir,
      entrypoint,
      configPath: fixture.workspaceConfigPath,
      args: ["--version"],
    });

    expect(shortResult.status).toBe(0);
    expect(longResult.status).toBe(0);
    expect(shortResult.stdout).toBe(longResult.stdout);
    expect(shortResult.stdout).toMatch(/^\d+\.\d+\.\d+$/);
    expect(shortResult.stderr).toBe("");
    expect(longResult.stderr).toBe("");
  });

  it("lists configured workspaces from the config file", async () => {
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

    const result = runCliCommand({
      workdir: tuiDir,
      entrypoint,
      configPath: fixture.workspaceConfigPath,
      args: ["list"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[apischeduler] APISCHEDULER-BACKEND-M: ${rootPath} [exists]`);
    expect(result.stdout).toContain(`[php] PHPAPP-M: ${phpPath} [exists]`);
    expect(result.stderr).toBe("");
  });

  it("applies selected folder indexes to an existing workspace file", async () => {
    const fixture = await setupFixture();
    const workspaceRoot = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
    const workspacePath = await writeWorkspaceFile(
      workspaceRoot,
      "apischeduler.code-workspace",
      `{
  "settings": {
    "editor.formatOnSave": true
  },
  "folders": [
    { "name": "ONE", "path": "./one" },
    { "name": "TWO", "path": "./two" },
    { "name": "THREE", "path": "./three" }
  ]
}
`,
    );

    const result = runCliCommand({
      workdir: tuiDir,
      entrypoint,
      configPath: fixture.workspaceConfigPath,
      args: ["apply", "--workspace", workspacePath, "--keep", "0,2"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Updated folders for ${workspacePath}. Kept indexes: 0,2`);

    const next = await readFile(workspacePath, "utf8");
    expect(next).toContain('"editor.formatOnSave": true');
    expect(next).toContain('"name": "ONE"');
    expect(next).toContain('"name": "THREE"');
    expect(next).not.toContain('"name": "TWO"');
  });

  it("validates an invalid workspace file and returns a non-zero status", async () => {
    const fixture = await setupFixture();
    const workspaceRoot = await createWorkspaceDir(fixture.rootDir, "services/api.scheduler");
    const workspacePath = await writeWorkspaceFile(workspaceRoot, "broken.code-workspace", '{"folders": [}',);

    const result = runCliCommand({
      workdir: tuiDir,
      entrypoint,
      configPath: fixture.workspaceConfigPath,
      args: ["validate", "--workspace", workspacePath],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Validation issues:");
    expect(result.stdout).toContain("CloseBracketExpected");
  });
});

async function setupFixture() {
  const fixture = await createFixtureContext();
  fixtures.push(fixture);
  return fixture;
}
