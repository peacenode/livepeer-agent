#!/bin/sh

set -eu

repository=${LIVEPEER_AGENT_REPOSITORY:-peacenode/livepeer-agent-releases}
version=${LIVEPEER_AGENT_VERSION:-latest}
install_root=${LIVEPEER_AGENT_INSTALL_ROOT:-"$HOME/.local/share/livepeer-agent"}
bin_dir=${LIVEPEER_AGENT_BIN_DIR:-"$HOME/.local/bin"}
token=${GH_TOKEN:-${GITHUB_TOKEN:-}}
asset_name=livepeer-agent.tgz
checksum_name=livepeer-agent.tgz.sha256

fail() {
  printf 'livepeer-agent installer: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v node >/dev/null 2>&1 || fail "Node.js 22.19 or newer is required: https://nodejs.org"
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || fail "Node.js 22.19 or newer is required (found $(node --version))"

case "$version" in
  *[!A-Za-z0-9._-]*) fail "LIVEPEER_AGENT_VERSION contains unsupported characters" ;;
esac

temporary=$(mktemp -d "${TMPDIR:-/tmp}/livepeer-agent-install.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

download() {
  source_url=$1
  destination=$2
  accept=$3
  if [ -n "$token" ]; then
    curl -fsSL --retry 3 \
      -H "Authorization: Bearer $token" \
      -H "Accept: $accept" \
      "$source_url" -o "$destination"
  else
    curl -fsSL --retry 3 -H "Accept: $accept" "$source_url" -o "$destination"
  fi
}

archive="$temporary/$asset_name"
checksum="$temporary/$checksum_name"

if [ -n "${LIVEPEER_AGENT_ASSET_BASE:-}" ]; then
  asset_base=${LIVEPEER_AGENT_ASSET_BASE%/}
  download "$asset_base/$asset_name" "$archive" application/octet-stream
  download "$asset_base/$checksum_name" "$checksum" text/plain
else
  api_base=${LIVEPEER_AGENT_API_BASE:-"https://api.github.com/repos/$repository"}
  metadata="$temporary/release.json"
  if [ "$version" = latest ]; then
    release_url="$api_base/releases/latest"
  else
    release_url="$api_base/releases/tags/$version"
  fi
  download "$release_url" "$metadata" application/vnd.github+json || \
    fail "could not read the public $version release from $repository"

  asset_url() {
    node -e '
  const { readFileSync } = require("node:fs");
  const release = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const asset = release.assets?.find((candidate) => candidate.name === process.argv[1]);
  if (!asset?.url) process.exit(1);
  process.stdout.write(asset.url);
' "$1" "$metadata"
  }

  archive_url=$(asset_url "$asset_name") || fail "$asset_name is missing from release $version"
  checksum_url=$(asset_url "$checksum_name") || fail "$checksum_name is missing from release $version"
  download "$archive_url" "$archive" application/octet-stream
  download "$checksum_url" "$checksum" application/octet-stream
fi

expected=$(awk -v name="$asset_name" '$NF == name || $NF == "*" name { print $1; exit }' "$checksum")
[ -n "$expected" ] || fail "release checksum is malformed"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$archive" | awk '{ print $1 }')
else
  fail "sha256sum or shasum is required to verify the release"
fi
[ "$actual" = "$expected" ] || fail "release checksum verification failed"

extracted="$temporary/extracted"
mkdir -p "$extracted"
tar -xzf "$archive" -C "$extracted"
[ -f "$extracted/package/dist/index.js" ] || fail "release is missing dist/index.js"
[ -f "$extracted/package/dist/openai-codex.js" ] || fail "release is missing dist/openai-codex.js"
[ -f "$extracted/package/dist/photon_rs_bg.wasm" ] || fail "release is missing photon_rs_bg.wasm"
chmod 755 "$extracted/package/dist/index.js"

release_dir="$install_root/releases/$actual"
for binary in livepeer livepeer-agent; do
  link="$bin_dir/$binary"
  managed_target="$install_root/current/dist/index.js"
  if [ -L "$link" ] && [ "$(readlink "$link")" != "$managed_target" ]; then
    fail "$link is a symlink not managed by this installer"
  fi
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    fail "$link already exists and is not managed by this installer"
  fi
done

mkdir -p "$install_root/releases" "$bin_dir"
if [ ! -d "$release_dir" ]; then
  mv "$extracted/package" "$release_dir"
fi
ln -sfn "$release_dir" "$install_root/current"

for binary in livepeer livepeer-agent; do
  link="$bin_dir/$binary"
  ln -sfn "$install_root/current/dist/index.js" "$link"
done

"$bin_dir/livepeer" --help >/dev/null

printf 'Installed Livepeer Agent to %s\n' "$install_root/current"
case ":$PATH:" in
  *":$bin_dir:"*) printf 'Run: livepeer\n' ;;
  *) printf 'Add %s to PATH, then run: livepeer\n' "$bin_dir" ;;
esac
