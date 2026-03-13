import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const START_MARKER = `# -----------------------------------------------------------------------------
# WORKSPACE MANAGER COPY ENVIRONMENT VARIABLES
# -----------------------------------------------------------------------------`;

const END_MARKER = `# -----------------------------------------------------------------------------
# /END/ WORKSPACE MANAGER COPY ENVIRONMENT VARIABLES
# -----------------------------------------------------------------------------`;

export function escapeForSingleQuotedBash(text: string): string {
  return text.replace(/'/g, `'\\''`);
}

export function quoteForSingleQuotedBash(text: string): string {
  return `'${escapeForSingleQuotedBash(text)}'`;
}

export function buildShellEnvPrefixedCommand(
  binary: string,
  args: string[],
  envVars: Record<string, string> = {},
): string {
  const prefixes = Object.keys(envVars)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${quoteForSingleQuotedBash(envVars[key] ?? "")}`);

  const command = [quoteForSingleQuotedBash(binary), ...args.map((arg) => quoteForSingleQuotedBash(arg))].join(" ");
  return [...prefixes, command].join(" ");
}

export function extractEnvExportSection(content: string, sourcePath: string): string {
  const startIndex = content.indexOf(START_MARKER);
  if (startIndex < 0) {
    throw new Error(`Missing start marker in ${sourcePath}`);
  }

  const endIndex = content.indexOf(END_MARKER, startIndex + START_MARKER.length);
  if (endIndex < 0) {
    throw new Error(`Missing end marker in ${sourcePath}`);
  }

  if (content.indexOf(START_MARKER, startIndex + START_MARKER.length) >= 0) {
    throw new Error(`Multiple start markers found in ${sourcePath}`);
  }

  if (content.indexOf(END_MARKER, endIndex + END_MARKER.length) >= 0) {
    throw new Error(`Multiple end markers found in ${sourcePath}`);
  }

  const section = content.slice(startIndex + START_MARKER.length, endIndex).trim();
  if (!section) {
    throw new Error(`Empty env-export section in ${sourcePath}`);
  }

  return section;
}

function parseNullDelimitedEnv(buffer: Buffer): Record<string, string> {
  const env: Record<string, string> = {};
  const entries = buffer.toString("utf8").split("\u0000").filter(Boolean);
  entries.forEach((entry) => {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1);
    env[key] = value;
  });
  return env;
}

function buildResolverScript(section: string): string {
  return `
set -euo pipefail
declare -A __wks_before_env=()
while IFS= read -r __wks_name; do
  __wks_before_env["$__wks_name"]="\${!__wks_name-}"
done < <(compgen -e)

${section}

while IFS= read -r __wks_name; do
  __wks_value="\${!__wks_name-}"
  if [[ ! -v __wks_before_env["$__wks_name"] ]] || [[ "\${__wks_before_env[$__wks_name]}" != "$__wks_value" ]]; then
    printf '%s=%s\\0' "$__wks_name" "$__wks_value"
  fi
done < <(compgen -e)
`;
}

export async function resolveExportedEnvironment(
  envExportFilePath: string,
  workspaceRootPath: string,
): Promise<Record<string, string>> {
  const resolvedFilePath = path.resolve(envExportFilePath);
  const resolvedWorkspaceRoot = path.resolve(workspaceRootPath);
  const content = await readFile(resolvedFilePath, "utf8");
  const section = extractEnvExportSection(content, resolvedFilePath);
  const result = spawnSync("bash", ["-s"], {
    cwd: resolvedWorkspaceRoot,
    env: process.env,
    input: buildResolverScript(section),
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(`Failed to evaluate ${resolvedFilePath}: ${String(result.error)}`);
  }

  if ((result.status ?? 0) !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(
      `Failed to evaluate ${resolvedFilePath}${stderr ? `: ${stderr}` : ` with status ${result.status ?? "unknown"}`}`,
    );
  }

  return parseNullDelimitedEnv(result.stdout);
}
