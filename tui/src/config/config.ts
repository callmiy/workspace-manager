import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { UserConfig, WorkspaceGroup, WorkspacePathConfig } from "../domain/types.js";

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "workspace-manager", "config-new.json");
export const CONFIG_PATH_ENV = "WORKSPACE_MANAGER_CONFIG";

export function defaultConfig(): UserConfig {
  return {
    groups: [],
  };
}

export function resolveConfigPath(): string {
  const overriddenPath = process.env[CONFIG_PATH_ENV];
  if (overriddenPath && overriddenPath.trim()) {
    return path.resolve(overriddenPath.trim());
  }
  return DEFAULT_CONFIG_PATH;
}

export async function ensureConfigDir(configPath: string = resolveConfigPath()): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePaths(group: Record<string, unknown>, groupIndex: number): WorkspacePathConfig[] {
  const rawPaths = group.paths;
  if (!Array.isArray(rawPaths)) {
    throw new Error(`Invalid config at groups[${groupIndex}].paths: expected an array`);
  }

  return rawPaths.map((value, pathIndex) => {
    if (!isRecord(value)) {
      throw new Error(`Invalid config at groups[${groupIndex}].paths[${pathIndex}]: expected an object`);
    }
    if (typeof value.path !== "string" || typeof value.name !== "string") {
      throw new Error(
        `Invalid config at groups[${groupIndex}].paths[${pathIndex}]: expected string 'name' and 'path'`,
      );
    }
    return { path: value.path, name: value.name };
  });
}

function toConfigGroups(input: unknown): WorkspaceGroup[] {
  if (!Array.isArray(input)) {
    throw new Error("Config root must be an array of groups");
  }

  return input.map((value, groupIndex) => {
    if (!isRecord(value)) {
      throw new Error(`Invalid config at groups[${groupIndex}]: expected an object`);
    }
    if (typeof value.group !== "string") {
      throw new Error(`Invalid config at groups[${groupIndex}].group: expected a string`);
    }

    const paths = parsePaths(value, groupIndex);
    if (paths.length === 0) {
      throw new Error(`Invalid config at groups[${groupIndex}].paths: expected at least one path entry`);
    }

    return { ...value, group: value.group, paths };
  });
}

function formatParseErrors(errors: ParseError[]): string {
  return errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join("; ");
}

export async function loadConfig(configPath: string = resolveConfigPath()): Promise<UserConfig> {
  const content = await readFile(configPath, "utf8");
  const errors: ParseError[] = [];
  const parsed = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });

  if (errors.length > 0) {
    throw new Error(`Invalid JSONC in ${configPath}: ${formatParseErrors(errors)}`);
  }

  const groups = toConfigGroups(parsed);
  return {
    ...defaultConfig(),
    groups,
  };
}
