#!/usr/bin/env node
import { execSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import packageJson from "../package.json" with { type: "json" };

function resolveVersion() {
  const envVersion = process.env.WKS_VERSION?.trim();
  if (envVersion) {
    return envVersion.replace(/^v/, "");
  }

  try {
    const tag = execSync("git describe --tags --exact-match", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();

    if (tag) {
      return tag.replace(/^v/, "");
    }
  } catch {
    // Fall through to package.json version.
  }

  return packageJson.version;
}

const version = resolveVersion();
const outfile = process.argv[2] ?? "./bin/_wks";
const targetArgs = process.argv.slice(3);

const result = spawnSync(
  "bun",
  [
    "build",
    "--compile",
    "--define",
    `__WKS_VERSION__=${JSON.stringify(version)}`,
    ...targetArgs,
    "--outfile",
    outfile,
    "./src/cli/index.ts",
  ],
  {
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
