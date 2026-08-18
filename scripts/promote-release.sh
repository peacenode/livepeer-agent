#!/bin/sh

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_repository=${LIVEPEER_AGENT_SOURCE_REPOSITORY:-peacenode/livepeer-agent}
public_repository=${LIVEPEER_AGENT_PUBLIC_REPOSITORY:-peacenode/livepeer-agent-releases}
gh_bin=${GH_BIN:-gh}
tag=${1:-}

fail() {
  printf 'livepeer-agent promotion: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: $0 vX.Y.Z"

command -v "$gh_bin" >/dev/null 2>&1 || fail "GitHub CLI is required"
command -v git >/dev/null 2>&1 || fail "git is required"
"$gh_bin" auth status >/dev/null 2>&1 || fail "GitHub CLI authentication is required"

cd "$root"
[ -z "$(git status --porcelain --untracked-files=normal)" ] || fail "source worktree must be clean"

node scripts/validate-release-version.mjs "$tag" >/dev/null || fail "tag does not match the canonical CLI package version"

for required in install.sh THIRD_PARTY_NOTICES.md packages/pi-coding-agent/LICENSE; do
  [ -f "$required" ] || fail "required distribution file is missing: $required"
done

"$gh_bin" release view "$tag" --repo "$source_repository" >/dev/null 2>&1 || \
  fail "private release $source_repository@$tag does not exist or is inaccessible"

temporary=$(mktemp -d "${TMPDIR:-/tmp}/livepeer-agent-promotion.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
private_assets="$temporary/private"
public_assets="$temporary/public"
mkdir "$private_assets" "$public_assets"

"$gh_bin" release download "$tag" \
  --repo "$source_repository" \
  --dir "$private_assets" \
  --pattern livepeer-agent.tgz \
  --pattern livepeer-agent.tgz.sha256

archive="$private_assets/livepeer-agent.tgz"
checksum="$private_assets/livepeer-agent.tgz.sha256"
[ -f "$archive" ] || fail "private release is missing livepeer-agent.tgz"
[ -f "$checksum" ] || fail "private release is missing livepeer-agent.tgz.sha256"

(
  cd "$private_assets"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c livepeer-agent.tgz.sha256
  elif command -v shasum >/dev/null 2>&1; then
    expected=$(awk '$NF == "livepeer-agent.tgz" || $NF == "*livepeer-agent.tgz" { print $1; exit }' livepeer-agent.tgz.sha256)
    [ -n "$expected" ] || fail "private release checksum is malformed"
    actual=$(shasum -a 256 livepeer-agent.tgz | awk '{ print $1 }')
    [ "$actual" = "$expected" ] || fail "private release checksum verification failed"
  else
    fail "sha256sum or shasum is required"
  fi
) >/dev/null || fail "private release checksum verification failed"

public_probe_error="$temporary/public-release-probe.err"
if "$gh_bin" api "repos/$public_repository/releases/tags/$tag" --silent 2>"$public_probe_error"; then
  fail "public release $public_repository@$tag already exists; refusing to overwrite"
elif ! grep -Eq 'HTTP 404|Not Found' "$public_probe_error"; then
  fail "could not confirm that public release $public_repository@$tag is absent"
fi

cp install.sh "$temporary/install.sh"
cp THIRD_PARTY_NOTICES.md "$temporary/THIRD_PARTY_NOTICES.md"
cp packages/pi-coding-agent/LICENSE "$temporary/PI_LICENSE"

"$gh_bin" release create "$tag" \
  "$archive" \
  "$checksum" \
  "$temporary/install.sh" \
  "$temporary/THIRD_PARTY_NOTICES.md" \
  "$temporary/PI_LICENSE" \
  --repo "$public_repository" \
  --title "Livepeer Agent $tag" \
  --notes "Livepeer Agent release. See THIRD_PARTY_NOTICES.md."

"$gh_bin" release download "$tag" \
  --repo "$public_repository" \
  --dir "$public_assets" \
  --pattern livepeer-agent.tgz \
  --pattern livepeer-agent.tgz.sha256

cmp "$archive" "$public_assets/livepeer-agent.tgz" >/dev/null || fail "public archive differs from private release"
cmp "$checksum" "$public_assets/livepeer-agent.tgz.sha256" >/dev/null || fail "public checksum differs from private release"

printf 'Promoted %s from %s to %s with matching artifact digests.\n' "$tag" "$source_repository" "$public_repository"
