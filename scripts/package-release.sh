#!/bin/sh

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
output=${1:-"$root/.build/releases/$timestamp"}

case "$output" in
  /*) ;;
  *) output="$root/$output" ;;
esac

[ ! -e "$output" ] || {
  printf 'release output already exists: %s\n' "$output" >&2
  exit 1
}
mkdir -p "$(dirname -- "$output")"
mkdir "$output"

cd "$root"
pnpm build
pnpm package:validate -- --output "$output/livepeer-agent.tgz"

cd "$output"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum livepeer-agent.tgz > livepeer-agent.tgz.sha256
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 livepeer-agent.tgz > livepeer-agent.tgz.sha256
else
  printf 'sha256sum or shasum is required\n' >&2
  exit 1
fi

printf 'release artifacts: %s\n' "$output"
