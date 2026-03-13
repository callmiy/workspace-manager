import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildShellEnvPrefixedCommand,
  extractEnvExportSection,
  quoteForSingleQuotedBash,
  resolveExportedEnvironment,
} from "../src/io/env-export.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.map(async (dir) => {
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }),
  );
  tmpDirs.length = 0;
});

describe("env export resolution", () => {
  it("extracts only the marked section", () => {
    const section = extractEnvExportSection(
      `export OUTSIDE=1
# -----------------------------------------------------------------------------
# WORKSPACE MANAGER COPY ENVIRONMENT VARIABLES
# -----------------------------------------------------------------------------
export FOO=bar
export BAZ="$FOO qux"
# -----------------------------------------------------------------------------
# /END/ WORKSPACE MANAGER COPY ENVIRONMENT VARIABLES
# -----------------------------------------------------------------------------
export AFTER=1
`,
      "/tmp/sample.sh",
    );

    expect(section).toContain('export FOO=bar');
    expect(section).toContain('export BAZ="$FOO qux"');
    expect(section).not.toContain("OUTSIDE");
    expect(section).not.toContain("AFTER");
  });

  it("resolves exported variables relative to the selected root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-env-"));
    tmpDirs.push(root);
    const workspaceRoot = path.join(root, "services", "api.scheduler--worktrees", "0");
    const envFile = path.join(root, "scripts", ".scratch-env-apischeduler.sh");

    await import("node:fs/promises").then((fs) => fs.mkdir(workspaceRoot, { recursive: true }));
    await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(envFile), { recursive: true }));

    await writeFile(
      envFile,
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
      "utf8",
    );

    const resolved = await resolveExportedEnvironment(envFile, workspaceRoot);
    expect(resolved.API_SCHEDULER_GIT_ROOT).toBe(workspaceRoot);
    expect(resolved.PYTHON_BIN).toBe(path.join(workspaceRoot, ".venv", "bin", "python"));
    expect(resolved.EBNIS_LINT_CMDS).toBe(`bash ${path.join(workspaceRoot, "lint.sh")}`);
  });

  it("fails when the marker section is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-env-bad-"));
    tmpDirs.push(root);
    const envFile = path.join(root, "missing-markers.sh");
    await writeFile(envFile, "export FOO=bar\n", "utf8");

    await expect(resolveExportedEnvironment(envFile, root)).rejects.toThrow("Missing start marker");
  });

  it("quotes values safely for single-quoted bash usage", () => {
    expect(quoteForSingleQuotedBash("plain")).toBe("'plain'");
    expect(quoteForSingleQuotedBash("bash /tmp/x.sh")).toBe("'bash /tmp/x.sh'");
    expect(quoteForSingleQuotedBash("it's-here")).toBe("'it'\\''s-here'");
  });

  it("builds a deterministic shell command for cursor launch", () => {
    const command = buildShellEnvPrefixedCommand(
      "cursor",
      ["/tmp/workspace.code-workspace"],
      {
        EBNIS_LINT_CMDS: "bash /tmp/lint.sh",
        GIT_SUBMODULE_RESET_ALL: "bash /tmp/reset.sh",
      },
    );

    expect(command).toBe(
      "EBNIS_LINT_CMDS='bash /tmp/lint.sh' GIT_SUBMODULE_RESET_ALL='bash /tmp/reset.sh' 'cursor' '/tmp/workspace.code-workspace'",
    );
  });
});
