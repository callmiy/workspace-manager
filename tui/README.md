# _wks (Workspace Manager TUI)

`_wks` is a terminal UI for managing `*.code-workspace` files and manually controlling the `folders` array to keep IDE LLM context focused.

## Install

### Public binary (no clone)

```bash
mkdir -p "$HOME/.local/bin" && \
curl -fL https://github.com/callmiy/workspace-manager/releases/latest/download/_wks-linux-x64.tar.gz \
  | tar -xzO _wks > "$HOME/.local/bin/_wks" && chmod +x "$HOME/.local/bin/_wks"
```

Alternative installer script:

```bash
curl -fsSL https://raw.githubusercontent.com/callmiy/workspace-manager/main/tui/scripts/install.sh | bash
```

Optional environment overrides for the installer script:

```bash
WKS_VERSION=vX.Y.Z WKS_BIN_DIR="$HOME/.local/bin" bash tui/scripts/install.sh
```

The direct download above writes `_wks` to `~/.local/bin/_wks`.
The installer script resolves the correct release asset for your platform and installs `_wks` to `~/.local/bin` by default.

### Cut a release

```bash
cd tui
npm run release -- 0.1.4
```

That script:

- updates `package.json` and `package-lock.json`
- creates a release commit
- creates annotated tag `v0.1.4`

To also push the commit and tag:

```bash
cd tui
npm run release -- 0.1.4 --push
```

### From source

```bash
cd tui
npm install
npm run build
npm link
```

After linking, `_wks` is available on your PATH.
`bun` must be installed because OpenTUI depends on Bun runtime modules.

### Release assets

GitHub Actions publishes these binary archives per release tag:

- `_wks-linux-x64.tar.gz`
- `_wks-darwin-arm64.tar.gz`

## Config

Create `~/.config/workspace-manager/config-new.json`:

```jsonc
[
  {
    "group": "apischeduler",
    "container-debug-path": "/opt/app/.cursor/",
    "docker-service": "apischeduler",
    "paths": [
      {
        "name": "APISCHEDULER-BACKEND-M",
        "path": "/home/adekanmiademiiju/alaya/accloud-lde/services/api.scheduler"
      },
      {
        "name": "APISCHEDULER-BACKEND-0",
        "path": "/home/adekanmiademiiju/alaya/accloud-lde/services/api.scheduler--worktrees/0"
      }
    ]
  }
]
```

Optional override:

```bash
export WORKSPACE_MANAGER_CONFIG=/abs/path/to/config-new.json
```

## Usage

```bash
_wks
```

### TUI keys

- `Root Workspace`: pick one configured root entry (`name: path`).
- `Associate Workspaces`: choose associated entries from other groups.
- only one selected associate per group is allowed.
- `enter`: open selected root
- `space`: toggle selected associate
- `a`: select first available item from each available group
- `n`: clear associate selections
- `/`: start search (search row appears only in search mode)
- `s`: open save preview
- `r`: refresh config/discovery (root screen)
- `o`: open config in `$EDITOR`
- `esc`: back / clear
- `q`: quit

### CLI commands

```bash
_wks list
_wks folders --workspace /abs/path/to/file.code-workspace
_wks apply --workspace /abs/path/to/file.code-workspace --keep 0,2,4
_wks validate --workspace /abs/path/to/file.code-workspace
```

## Testing

```bash
npm test
npm run test:e2e
```

`test:e2e` covers both the terminal-driven TUI flow and real CLI subprocess flows. `tmux` and `bun` must be available on the machine.

## Safety behavior

- Reuses an existing workspace file in selected root:
  - `*.code-workspace` in root first (alphabetical)
  - then `.vscode/*.code-workspace` (alphabetical)
- If none exists, creates `<root-name-lowercase>.code-workspace` in root.
- Rewrites only the `folders` array for existing files and preserves other keys.
- Writes atomically (`.tmp` + rename).
