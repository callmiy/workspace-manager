#!/usr/bin/env bash
set -euo pipefail

REPO="${WKS_REPO:-callmiy/workspace-manager}"
BIN_DIR="${WKS_BIN_DIR:-$HOME/.local/bin}"
VERSION="${WKS_VERSION:-latest}"

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    echo "Unsupported OS: $uname_s" >&2
    exit 1
    ;;
esac

case "$uname_m" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    echo "Unsupported architecture: $uname_m" >&2
    exit 1
    ;;
esac

asset="wks-${os}-${arch}.tar.gz"

if [[ "$VERSION" == "latest" ]]; then
  api_url="https://api.github.com/repos/${REPO}/releases/latest"
  tag="$(curl -fsSL "$api_url" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [[ -z "$tag" ]]; then
    echo "Failed to resolve latest release tag from ${api_url}" >&2
    exit 1
  fi
else
  tag="$VERSION"
fi

url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

archive_path="${tmp_dir}/${asset}"

mkdir -p "$BIN_DIR"

echo "Downloading ${url}"
curl -fL "$url" -o "$archive_path"

tar -xzf "$archive_path" -C "$tmp_dir"
install -m 0755 "$tmp_dir/wks" "$BIN_DIR/wks"

echo "Installed wks to ${BIN_DIR}/wks"
case ":$PATH:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo "${BIN_DIR} is not in PATH"
    echo "Add this to your shell config:"
    echo "  export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac
