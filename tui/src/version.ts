import packageJson from "../package.json" with { type: "json" };
import { execSync } from "node:child_process";

declare const __WKS_VERSION__: string | undefined;

function resolveVersion(): string {
  if (typeof __WKS_VERSION__ === "string" && __WKS_VERSION__.length > 0) {
    return __WKS_VERSION__;
  }

  if (typeof process.env.WKS_VERSION === "string" && process.env.WKS_VERSION.length > 0) {
    return process.env.WKS_VERSION.replace(/^v/, "");
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

export const WKS_VERSION = resolveVersion();
