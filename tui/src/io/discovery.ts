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
  let order = 0;
  const orderedEntries = config.groups.flatMap((group) =>
    group.paths.map((entry) => ({
      group,
      entry,
      order: order++,
      workspacePath: path.resolve(entry.path),
    })),
  );

  const existingByPath = new Map<string, boolean>();
  await Promise.all(
    orderedEntries.map(async (candidate) => {
      existingByPath.set(candidate.workspacePath, await pathExists(candidate.workspacePath));
    }),
  );

  orderedEntries
    .sort((a, b) => a.order - b.order)
    .forEach(({ group, entry, workspacePath }) => {
      if (refs.has(workspacePath)) {
        return;
      }
      const { group: _group, paths: _paths, ...metadata } = group;
      refs.set(workspacePath, {
        id: hashId(`${group.group}:${workspacePath}:${entry.name}`),
        group: group.group,
        name: entry.name,
        path: workspacePath,
        existsOnDisk: existingByPath.get(workspacePath) ?? false,
        metadata,
      });
    });

  return [...refs.values()];
}
