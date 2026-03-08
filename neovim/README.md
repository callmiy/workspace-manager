# wks.nvim

`wks.nvim` is a thin Neovim launcher for the existing `_wks` TUI. It does not reimplement workspace management logic inside Neovim; it opens the real `_wks` binary in a terminal tab or floating terminal.

## Requirements

- Neovim `0.11+`
- `_wks` available on your `PATH`, or configured explicitly

## Install

### lazy.nvim (URL install)

Install from the standalone plugin repository:

```lua
{
  "callmiy/workspace-manager-neovim",
  opts = {
    binary = "_wks",
    default_mode = "tab",
    float = {
      width = 0.9,
      height = 0.9,
      border = "rounded",
    },
  },
}
```

## Usage

- `:Wks` launches `_wks` using the configured default mode
- `:Wks tab` launches `_wks` in a new tab terminal
- `:Wks float` launches `_wks` in a floating terminal
- `:help wks` opens plugin help

Default behavior:

- `tab` mode opens a new tab, runs `_wks`, and closes the tab when `_wks` exits
- `float` mode opens a centered floating terminal and closes it when `_wks` exits
- non-zero exits surface a Neovim error notification
- missing binaries surface a Neovim error notification

## Notes

- v1 is intentionally launcher-only
- workspace discovery, fuzzy search, save preview, `$EDITOR`, and Cursor integration remain implemented inside `_wks`
