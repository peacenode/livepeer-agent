#!/bin/sh

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifact=${1:-}
[ -n "$artifact" ] || {
  printf 'usage: %s /path/to/livepeer-agent.tgz\n' "$0" >&2
  exit 1
}
case "$artifact" in
  /*) ;;
  *) artifact="$root/$artifact" ;;
esac
[ -f "$artifact" ] || {
  printf 'release artifact not found: %s\n' "$artifact" >&2
  exit 1
}

temporary=$(mktemp -d "${TMPDIR:-/tmp}/livepeer-installer-test.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
assets="$temporary/assets"
api="$temporary/api"
home="$temporary/home"
mkdir -p "$assets" "$api/releases" "$home"
cp "$artifact" "$assets/livepeer-agent.tgz"

cd "$assets"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum livepeer-agent.tgz > livepeer-agent.tgz.sha256
else
  shasum -a 256 livepeer-agent.tgz > livepeer-agent.tgz.sha256
fi
printf '{"assets":[{"name":"livepeer-agent.tgz","url":"file://%s/livepeer-agent.tgz"},{"name":"livepeer-agent.tgz.sha256","url":"file://%s/livepeer-agent.tgz.sha256"}]}' \
  "$assets" "$assets" > "$api/releases/latest"

HOME="$home" LIVEPEER_AGENT_ASSET_BASE="file://$assets" sh "$root/install.sh"
HOME="$home" LIVEPEER_AGENT_API_BASE="file://$api" sh "$root/install.sh"
HOME="$home" XDG_CONFIG_HOME="$temporary/config" "$home/.local/bin/livepeer" --help | grep -q 'Livepeer media tools and terminal agent'
HOME="$home" XDG_CONFIG_HOME="$temporary/config" "$home/.local/bin/livepeer-agent" --help | grep -q 'Livepeer media tools and terminal agent'
HOME="$home" XDG_CONFIG_HOME="$temporary/config" \
  LIVEPEER_AGENT_RELEASES_API='data:application/json,%7B%22tag_name%22%3A%22v0.1.2%22%7D' \
  "$home/.local/bin/livepeer" update --check --json | grep -q '"updateAvailable":true'

printf 'installer validation passed\n'
