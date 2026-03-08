#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

nvim --headless -u NONE \
  -c "lua dofile('${repo_root}/neovim/test/headless_spec.lua')" \
  -c "qa!"
