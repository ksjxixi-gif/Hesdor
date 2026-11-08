#!/bin/sh
# Installs the standalone hesdor binary for Linux or macOS (x64, arm64) from GitHub releases.
#   curl -fsSL https://raw.githubusercontent.com/ksjxixi-gif/Hesdor/main/packaging/install.sh | sh
# Environment: HESDOR_VERSION (default latest), HESDOR_INSTALL_DIR (default ~/.local/bin),
# HESDOR_BASE_URL (default the GitHub releases page). Refuses to install on a SHA256 mismatch.
set -eu

version=${HESDOR_VERSION:-latest}
version=${version#v}
dir=${HESDOR_INSTALL_DIR:-$HOME/.local/bin}
base_url=${HESDOR_BASE_URL:-https://github.com/ksjxixi-gif/Hesdor/releases}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) echo "hesdor: unsupported OS $(uname -s); on Windows use install.ps1" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "hesdor: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
asset="hesdor-$os-$arch.tar.gz"
if [ "$version" = latest ]; then base="$base_url/latest/download"; else base="$base_url/download/v$version"; fi

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -qO "$2" "$1"; }
else echo "hesdor: need curl or wget" >&2; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else echo "hesdor: need sha256sum or shasum" >&2; exit 1; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $base/$asset"
fetch "$base/$asset" "$tmp/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"

expected=$(awk -v a="$asset" '$2 == a || $2 == "*" a { print tolower($1); exit }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || { echo "hesdor: SHA256SUMS has no entry for $asset" >&2; exit 1; }
actual=$(sha256 "$tmp/$asset" | tr 'A-F' 'a-f')
if [ "$actual" != "$expected" ]; then
  echo "hesdor: checksum mismatch for $asset: expected $expected, got $actual. Nothing was installed." >&2
  exit 1
fi

tar -xzf "$tmp/$asset" -C "$tmp" hesdor
mkdir -p "$dir"
# Copy then rename, so a running hesdor is never left half-written.
cp "$tmp/hesdor" "$dir/.hesdor.new" && chmod 755 "$dir/.hesdor.new" && mv -f "$dir/.hesdor.new" "$dir/hesdor"
echo "Installed $dir/hesdor"
case ":$PATH:" in
  *":$dir:"*) echo "Run: hesdor --help" ;;
  *) echo "Add $dir to your PATH, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
esac
