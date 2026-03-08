import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_PATH_ENV, loadConfig, resolveConfigPath } from "../src/config/config.js";

const tmpDirs: string[] = [];
const originalEnv = process.env[CONFIG_PATH_ENV];

afterEach(async () => {
  await Promise.all(
    tmpDirs.map(async (dir) => {
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }),
  );
  tmpDirs.length = 0;

  if (typeof originalEnv === "string") {
    process.env[CONFIG_PATH_ENV] = originalEnv;
  } else {
    delete process.env[CONFIG_PATH_ENV];
  }
});

describe("config", () => {
  it("loads grouped config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-conf-"));
    tmpDirs.push(root);
    const configPath = path.join(root, "config-new.json");

    await writeFile(
      configPath,
      JSON.stringify([
        {
          group: "php",
          "container-debug-path": "/data/docroot/.cursor",
          "docker-service": "app",
          paths: [{ name: "PHPAPP-M", path: "/tmp/php-main" }],
        },
      ]),
      "utf8",
    );

    const config = await loadConfig(configPath);
    expect(config.groups).toHaveLength(1);
    expect(config.groups[0]?.group).toBe("php");
    expect(config.groups[0]?.paths[0]?.name).toBe("PHPAPP-M");
  });

  it("uses WORKSPACE_MANAGER_CONFIG when set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-conf-env-"));
    tmpDirs.push(root);
    const configPath = path.join(root, "config-new.json");
    await writeFile(configPath, "[]", "utf8");

    process.env[CONFIG_PATH_ENV] = configPath;
    expect(resolveConfigPath()).toBe(configPath);
  });

  it("fails loudly for malformed group/path entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wks-conf-bad-"));
    tmpDirs.push(root);
    const configPath = path.join(root, "config-new.json");

    await writeFile(
      configPath,
      JSON.stringify([
        {
          group: "php",
          paths: [{ path: "/tmp/php-main" }],
        },
      ]),
      "utf8",
    );

    await expect(loadConfig(configPath)).rejects.toThrow("groups[0].paths[0]");
  });
});
