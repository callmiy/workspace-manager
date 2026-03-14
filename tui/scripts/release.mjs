#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const packageLockPath = path.join(repoRoot, "package-lock.json");

function usage() {
  console.error(`Usage:
  node tui/scripts/release.mjs <version> [--push] [--dry-run]

Examples:
  node tui/scripts/release.mjs 0.1.4
  node tui/scripts/release.mjs v0.1.4 --push
  node tui/scripts/release.mjs v0.1.4 --dry-run`);
}

function normalizeVersion(input) {
  const trimmed = input.trim();
  const normalized = trimmed.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Invalid version: ${input}`);
  }
  return normalized;
}

function replaceJsonVersion(content, version) {
  return content.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);
}

function writeJsonVersion(filePath, version) {
  const original = readFileSync(filePath, "utf8");
  const next = replaceJsonVersion(original, version);
  if (next === original) {
    throw new Error(`Could not update version in ${filePath}`);
  }
  writeFileSync(filePath, next);
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: path.resolve(repoRoot, ".."),
    stdio: "inherit",
  });
}

function ensureClean() {
  const output = execFileSync("git", ["status", "--short"], {
    cwd: path.resolve(repoRoot, ".."),
    encoding: "utf8",
  }).trim();

  if (output.length > 0) {
    throw new Error("Working tree is dirty. Commit or stash changes before cutting a release");
  }
}

function ensureTagAbsent(tag) {
  try {
    execFileSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
      cwd: path.resolve(repoRoot, ".."),
      stdio: "ignore",
    });
    throw new Error(`Tag ${tag} already exists`);
  } catch (error) {
    if (!(error instanceof Error) || !String(error.message).includes(`Tag ${tag} already exists`)) {
      return;
    }
    throw error;
  }
}

const args = process.argv.slice(2);
const push = args.includes("--push");
const dryRun = args.includes("--dry-run");
const versionArg = args.find((arg) => !arg.startsWith("--"));

if (!versionArg) {
  usage();
  process.exit(1);
}

const version = normalizeVersion(versionArg);
const tag = `v${version}`;

if (!dryRun) {
  ensureClean();
  ensureTagAbsent(tag);
}

if (dryRun) {
  const packageJsonPreview = replaceJsonVersion(readFileSync(packageJsonPath, "utf8"), version);
  const packageLockPreview = replaceJsonVersion(readFileSync(packageLockPath, "utf8"), version);
  console.log(`Dry run for ${tag}`);
  console.log(`- package.json version -> ${JSON.parse(packageJsonPreview).version}`);
  console.log(`- package-lock.json version -> ${JSON.parse(packageLockPreview).version}`);
  process.exit(0);
}

writeJsonVersion(packageJsonPath, version);
writeJsonVersion(packageLockPath, version);

runGit(["add", "tui/package.json", "tui/package-lock.json"]);
runGit(["commit", "-m", `Release ${tag}`, "-m", `Align the fallback package version and install docs with ${tag}`]);
runGit(["tag", "-a", tag, "-m", tag]);

if (push) {
  runGit(["push", "origin", "HEAD"]);
  runGit(["push", "origin", tag]);
}

console.log(`Created release commit and tag ${tag}`);
if (!push) {
  console.log(`Push when ready:
  git push origin HEAD
  git push origin ${tag}`);
}
