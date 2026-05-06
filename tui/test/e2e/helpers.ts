import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

type WorkspaceGroupFixture = {
  group: string;
  metadata?: Record<string, unknown>;
  paths: Array<{
    name: string;
    path: string;
  }>;
};

type FixtureContext = {
  rootDir: string;
  workspaceConfigPath: string;
  binDir: string;
  editorLogPath: string;
  cursorLogPath: string;
  clipboardLogPath: string;
  nvimLogPath: string;
  cursorEnvLogPath: string;
};

function runTmux(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
  }).trimEnd();
}

function buildShellCommand(env: Record<string, string>, entrypoint: string, args: string[] = []): string {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const argSuffix = args.map((arg) => JSON.stringify(arg)).join(" ");
  return `${envPrefix} bun run ${JSON.stringify(entrypoint)}${argSuffix ? ` ${argSuffix}` : ""}`;
}

export async function createFixtureContext(): Promise<FixtureContext> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wks-e2e-"));
  const workspaceConfigPath = path.join(rootDir, "config-new.json");
  const binDir = path.join(rootDir, "bin");
  const editorLogPath = path.join(rootDir, "editor.log");
  const cursorLogPath = path.join(rootDir, "cursor.log");
  const clipboardLogPath = path.join(rootDir, "clipboard.log");
  const cursorEnvLogPath = path.join(rootDir, "cursor-env.log");
  const nvimLogPath = path.join(rootDir, "nvim.log");

  await mkdir(binDir, { recursive: true });
  await writeStubBinary(path.join(binDir, "stub-editor"), editorLogPath);
  await writeStubBinary(path.join(binDir, "cursor"), cursorLogPath, cursorEnvLogPath);
  await writeClipboardStub(path.join(binDir, "wl-copy"), clipboardLogPath);
  await writeStubBinary(path.join(binDir, "nvim"), nvimLogPath);

  return {
    rootDir,
    workspaceConfigPath,
    binDir,
    editorLogPath,
    cursorLogPath,
    clipboardLogPath,
    nvimLogPath,
    cursorEnvLogPath,
  };
}

async function writeStubBinary(filePath: string, logPath: string, envLogPath?: string): Promise<void> {
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ -n "\${WKS_STUB_ENV_KEYS:-}" ]] && [[ -n ${JSON.stringify(envLogPath ?? "")} ]]; then
  while IFS= read -r __wks_key; do
    [[ -z "$__wks_key" ]] && continue
    printf '%s=%s\\n' "$__wks_key" "\${!__wks_key-}" >> ${JSON.stringify(envLogPath ?? "")}
  done < <(printf '%s\\n' "$WKS_STUB_ENV_KEYS" | tr ',' '\\n')
fi
`;
  await writeFile(filePath, script, "utf8");
  await chmod(filePath, 0o755);
}

async function writeClipboardStub(filePath: string, logPath: string): Promise<void> {
  const script = `#!/usr/bin/env bash
set -euo pipefail
cat >> ${JSON.stringify(logPath)}
printf '\\n' >> ${JSON.stringify(logPath)}
`;
  await writeFile(filePath, script, "utf8");
  await chmod(filePath, 0o755);
}

export async function cleanupFixtureContext(context: FixtureContext): Promise<void> {
  await rm(context.rootDir, { recursive: true, force: true });
}

export async function writeWorkspaceConfig(
  configPath: string,
  groups: WorkspaceGroupFixture[],
): Promise<void> {
  await writeFile(
    configPath,
    `${JSON.stringify(
      groups.map((group) => ({
        group: group.group,
        ...group.metadata,
        paths: group.paths,
      })),
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function createWorkspaceDir(rootDir: string, relativePath: string): Promise<string> {
  const targetPath = path.join(rootDir, relativePath);
  await mkdir(targetPath, { recursive: true });
  return targetPath;
}

export async function writeWorkspaceFile(
  rootPath: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const workspacePath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(workspacePath), { recursive: true });
  await writeFile(workspacePath, content, "utf8");
  return workspacePath;
}

function normalizePane(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

export class TmuxHarness {
  private readonly sessionName: string;

  private readonly target: string;

  constructor(sessionName: string) {
    this.sessionName = sessionName;
    this.target = sessionName;
  }

  static async launch(options: {
    workdir: string;
    entrypoint: string;
    args?: string[];
    configPath: string;
    binDir: string;
    editorCommand?: string;
    nvimServer?: string;
    stubEnvKeys?: string[];
  }): Promise<TmuxHarness> {
    const sessionName = `wks-e2e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const env = {
      PATH: `${options.binDir}:${process.env.PATH ?? ""}`,
      WORKSPACE_MANAGER_CONFIG: options.configPath,
      EDITOR: options.editorCommand ?? "stub-editor --wait",
      NVIM: options.nvimServer ?? "",
      TERM: process.env.TERM ?? "screen-256color",
      WKS_STUB_ENV_KEYS: (options.stubEnvKeys ?? []).join(","),
    };

    runTmux([
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      "140",
      "-y",
      "40",
      "-c",
      options.workdir,
      buildShellCommand(env, options.entrypoint, options.args),
    ]);

    return new TmuxHarness(sessionName);
  }

  async cleanup(): Promise<void> {
    try {
      runTmux(["kill-session", "-t", this.sessionName]);
    } catch {
      // Ignore missing sessions during cleanup.
    }
  }

  capture(): string {
    return normalizePane(runTmux(["capture-pane", "-p", "-t", this.target]));
  }

  sendKey(key: string): void {
    runTmux(["send-keys", "-t", this.target, key]);
  }

  sendKeys(keys: string[]): void {
    keys.forEach((key) => {
      this.sendKey(key);
    });
  }

  async waitForText(text: string, timeoutMs: number = 10_000): Promise<string> {
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const pane = this.capture();
      if (pane.includes(text)) {
        return pane;
      }
      await wait(100);
    }

    throw new Error(`Timed out waiting for text: ${text}\nCurrent pane:\n${this.capture()}`);
  }

  async waitForMissingText(text: string, timeoutMs: number = 10_000): Promise<string> {
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const pane = this.capture();
      if (!pane.includes(text)) {
        return pane;
      }
      await wait(100);
    }

    throw new Error(`Timed out waiting for text to disappear: ${text}\nCurrent pane:\n${this.capture()}`);
  }
}

export async function readLogLines(logPath: string): Promise<string[]> {
  try {
    const content = await readFile(logPath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function runCliCommand(options: {
  workdir: string;
  entrypoint: string;
  configPath: string;
  args: string[];
}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("bun", ["run", options.entrypoint, ...options.args], {
    cwd: options.workdir,
    env: {
      ...process.env,
      WORKSPACE_MANAGER_CONFIG: options.configPath,
    },
    encoding: "utf8",
  });

  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

async function wait(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
