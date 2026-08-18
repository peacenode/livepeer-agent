#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
corepack_home=${COREPACK_HOME:-"$HOME/.cache/node/corepack"}
temp_parent=${TMPDIR:-/tmp}
test_root=$(mktemp -d "${temp_parent%/}/livepeer-agent-tests.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
mkdir -p "$test_root/home" "$test_root/tmp" "$test_root/xdg"

run_isolated() {
  env -i \
    PATH="$root/packages/pi-coding-agent/test/support/bin:$PATH" \
    HOME="$test_root/home" \
    TMPDIR="$test_root/tmp" \
    XDG_CONFIG_HOME="$test_root/xdg" \
    COREPACK_HOME="$corepack_home" \
    CI="${CI:-}" \
    TERM="xterm-256color" \
    LIVEPEER_OFFLINE="1" \
    PI_OFFLINE="1" \
    GIT_CONFIG_NOSYSTEM="1" \
    GIT_AUTHOR_NAME="Livepeer Tests" \
    GIT_AUTHOR_EMAIL="tests@invalid.example" \
    GIT_COMMITTER_NAME="Livepeer Tests" \
    GIT_COMMITTER_EMAIL="tests@invalid.example" \
    npm_config_audit="false" \
    npm_config_fund="false" \
    "$@"
}

cd "$root"
run_isolated pnpm test
run_isolated pnpm --filter @livepeer/pi-coding-agent test:offline
