import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySelection,
  loadWorkspace,
  resolveWorkspaceTarget,
  validateWorkspace,
  writeWorkspaceFolders,
} from "../src/io/workspace.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.map(async (dir) => {
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }),
  );
  tmpDirs.length = 0;
});

describe("workspace IO", () => {
  it("loads folders and resolves existence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-load-"));
    tmpDirs.push(root);

    const existing = path.join(root, "existing-folder");
    await mkdir(existing, { recursive: true });

    const workspacePath = path.join(root, "sample.code-workspace");
    await writeFile(
      workspacePath,
      `{
  "settings": { "editor.tabSize": 2 },
  "folders": [
    { "path": "./existing-folder", "name": "EXISTING", "container-debug-path": "/app/.cursor/" },
    { "path": "./missing-folder", "name": "MISSING" }
  ]
}
`,
      "utf8",
    );

    const doc = await loadWorkspace(workspacePath);
    expect(doc.folders).toHaveLength(2);
    expect(doc.folders[0]?.existsOnDisk).toBe(true);
    expect(doc.folders[0]?.containerDebugPath).toBe("/app/.cursor/");
    expect(doc.folders[1]?.existsOnDisk).toBe(false);
  });

  it("applySelection rewrites folders while preserving other keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-apply-"));
    tmpDirs.push(root);

    const workspacePath = path.join(root, "sample.code-workspace");
    await writeFile(
      workspacePath,
      `{
  "settings": { "editor.formatOnSave": true },
  "folders": [
    { "path": "./one", "name": "ONE" },
    { "path": "./two", "name": "TWO" },
    { "path": "./three", "name": "THREE" }
  ]
}
`,
      "utf8",
    );

    await applySelection({
      workspacePath,
      selectedIndexes: [0, 2],
      createBackup: false,
    });

    const next = await readFile(workspacePath, "utf8");
    expect(next).toContain('"editor.formatOnSave": true');
    expect(next).toContain('"name": "ONE"');
    expect(next).toContain('"name": "THREE"');
    expect(next).not.toContain('"name": "TWO"');
  });

  it("validateWorkspace returns parse diagnostics for invalid JSONC", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-val-"));
    tmpDirs.push(root);

    const workspacePath = path.join(root, "broken.code-workspace");
    await writeFile(workspacePath, '{"folders": [}', "utf8");

    const result = await validateWorkspace(workspacePath);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("resolveWorkspaceTarget prefers root workspace files over .vscode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-target-"));
    tmpDirs.push(root);

    await mkdir(path.join(root, ".vscode"), { recursive: true });
    await writeFile(path.join(root, "b.code-workspace"), '{"folders": []}', "utf8");
    await writeFile(path.join(root, "a.code-workspace"), '{"folders": []}', "utf8");
    await writeFile(path.join(root, ".vscode", "c.code-workspace"), '{"folders": []}', "utf8");

    const selected = await resolveWorkspaceTarget(root);
    expect(selected).toBe(path.join(root, "a.code-workspace"));
  });

  it("writeWorkspaceFolders creates and rewrites workspace files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-write-"));
    tmpDirs.push(root);

    const createdWorkspace = path.join(root, "created.code-workspace");
    await writeWorkspaceFolders(
      createdWorkspace,
      [
        {
          name: "ROOT",
          path: "/tmp/root",
          metadata: { "container-debug-path": "/opt/app/.cursor/", "docker-service": "api" },
        },
      ],
      false,
    );
    const createdContent = await readFile(createdWorkspace, "utf8");
    expect(createdContent).toContain('"name": "ROOT"');
    expect(createdContent).toContain('"docker-service": "api"');

    const existingWorkspace = path.join(root, "existing.code-workspace");
    await writeFile(existingWorkspace, '{"settings":{"editor.tabSize":2},"folders":[{"name":"OLD","path":"/tmp/old"}]}', "utf8");
    await writeWorkspaceFolders(
      existingWorkspace,
      [
        {
          name: "NEW",
          path: "/tmp/new",
        },
      ],
      false,
    );

    const rewrittenContent = await readFile(existingWorkspace, "utf8");
    expect(rewrittenContent).toContain('"editor.tabSize":2');
    expect(rewrittenContent).toContain('"name": "NEW"');
    expect(rewrittenContent).not.toContain('"name": "OLD"');
  });
});
