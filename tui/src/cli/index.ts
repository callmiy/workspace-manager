#!/usr/bin/env bun
import { loadConfig } from "../config/config.js";
import { discoverWorkspaces } from "../io/discovery.js";
import { applySelection, loadWorkspace, validateWorkspace } from "../io/workspace.js";
import { runTui } from "../app/tui.js";
import { WKS_VERSION } from "../version.js";

type ParsedArgs = {
  command?: string;
  flags: Map<string, string>;
};

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 1 && (argv[0] === "-v" || argv[0] === "--version")) {
    return { command: "version", flags: new Map() };
  }

  const [command, ...rest] = argv;
  const flags = new Map<string, string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }
    if (token.length === 2) {
      throw new Error("Invalid flag '--'");
    }

    const equalIndex = token.indexOf("=");
    if (equalIndex >= 0) {
      const key = token.slice(2, equalIndex);
      const value = token.slice(equalIndex + 1);
      if (!key) {
        throw new Error(`Invalid flag syntax: ${token}`);
      }
      flags.set(key, value);
      continue;
    }

    const key = token.slice(2);
    if (!key) {
      throw new Error(`Invalid flag syntax: ${token}`);
    }

    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    flags.set(key, next);
    i += 1;
  }

  return { command, flags };
}

function parseKeepIndexes(value: string | undefined): number[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((index) => Number.isFinite(index) && index >= 0);
}

function printUsage(): void {
  console.log(`wks commands:
  wks                               Launch interactive TUI
  wks -v | --version                Print version
  wks list                          List discovered workspace files
  wks folders --workspace <path>    List folder entries for workspace
  wks apply --workspace <path> --keep <csv-indexes>
  wks validate --workspace <path>`);
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) {
    await runTui();
    return;
  }

  if (args.command === "version") {
    console.log(WKS_VERSION);
    return;
  }

  if (args.command === "list") {
    const config = await loadConfig();
    const refs = await discoverWorkspaces(config);
    refs.forEach((ref, index) => {
      console.log(`${index + 1}. [${ref.group}] ${ref.name}: ${ref.path} [${ref.existsOnDisk ? "exists" : "missing"}]`);
    });
    return;
  }

  if (args.command === "folders") {
    const workspace = args.flags.get("workspace");
    if (!workspace) {
      throw new Error("Missing --workspace <path>");
    }
    const doc = await loadWorkspace(workspace);
    doc.folders.forEach((folder) => {
      console.log(
        `${folder.index}: ${folder.name ?? "(unnamed)"} | ${folder.path} | ${folder.existsOnDisk ? "exists" : "missing"}`,
      );
    });
    return;
  }

  if (args.command === "apply") {
    const workspace = args.flags.get("workspace");
    if (!workspace) {
      throw new Error("Missing --workspace <path>");
    }

    const keepIndexes = parseKeepIndexes(args.flags.get("keep"));
    await applySelection({
      workspacePath: workspace,
      selectedIndexes: keepIndexes,
      createBackup: false,
    });

    console.log(`Updated folders for ${workspace}. Kept indexes: ${keepIndexes.join(",") || "(none)"}`);
    return;
  }

  if (args.command === "validate") {
    const workspace = args.flags.get("workspace");
    if (!workspace) {
      throw new Error("Missing --workspace <path>");
    }

    const validation = await validateWorkspace(workspace);
    if (validation.ok) {
      console.log("OK");
      return;
    }

    console.log("Validation issues:");
    validation.diagnostics.forEach((diagnostic) => {
      console.log(`- ${diagnostic}`);
    });
    process.exitCode = 1;
    return;
  }

  printUsage();
  process.exitCode = 1;
}

run().catch((error: unknown) => {
  console.error(`wks error: ${String(error)}`);
  process.exit(1);
});
