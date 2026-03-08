import { access } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { UserConfig, WorkspaceRef } from "../domain/types.js";

function hashId(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function discoverWorkspaces(config: UserConfig): Promise<WorkspaceRef[]> {
  const refs = new Map<string, WorkspaceRef>();

  await Promise.all(
    config.groups.map(async (group) => {
      await Promise.all(
        group.paths.map(async (entry) => {
          const workspacePath = path.resolve(entry.path);
          const { group: _group, paths: _paths, ...metadata } = group;

          refs.set(workspacePath, {
            id: hashId(`${group.group}:${workspacePath}:${entry.name}`),
            group: group.group,
            name: entry.name,
            path: workspacePath,
            existsOnDisk: await pathExists(workspacePath),
            metadata,
          });
        }),
      );
    }),
  );

  return [...refs.values()];
}
