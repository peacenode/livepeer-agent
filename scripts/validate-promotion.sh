#!/bin/sh

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/livepeer-promotion-test.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
fixture="$temporary/repository"
fake_bin="$temporary/bin"
private_assets="$temporary/private-assets"
public_assets="$temporary/public-assets"
mkdir -p "$fixture/apps/cli" "$fixture/packages/pi-coding-agent" "$fixture/scripts" "$fake_bin" "$private_assets" "$public_assets"

cp "$root/scripts/promote-release.sh" "$fixture/scripts/promote-release.sh"
cp "$root/scripts/validate-release-version.mjs" "$fixture/scripts/validate-release-version.mjs"
cp "$root/install.sh" "$fixture/install.sh"
printf '{"version":"0.1.0"}\n' > "$fixture/apps/cli/package.json"
printf 'notices fixture\n' > "$fixture/THIRD_PARTY_NOTICES.md"
printf 'Pi license fixture\n' > "$fixture/packages/pi-coding-agent/LICENSE"
printf 'release archive fixture\n' > "$private_assets/livepeer-agent.tgz"
(
  cd "$private_assets"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum livepeer-agent.tgz > livepeer-agent.tgz.sha256
  else
    shasum -a 256 livepeer-agent.tgz > livepeer-agent.tgz.sha256
  fi
)

cat > "$fake_bin/gh" <<'EOF'
#!/bin/sh
set -eu
command=$1
subcommand=${2:-}
shift 2 || true
case "$command:$subcommand" in
  auth:status|release:view) exit 0 ;;
  api:*)
    if [ "${FAKE_PUBLIC_EXISTS:-0}" = 1 ]; then
      exit 0
    fi
    printf 'gh: Not Found (HTTP 404)\n' >&2
    exit 1
    ;;
  release:download)
    tag=$1
    shift
    repository=
    destination=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --repo) repository=$2; shift 2 ;;
        --dir) destination=$2; shift 2 ;;
        --pattern) shift 2 ;;
        *) shift ;;
      esac
    done
    mkdir -p "$destination"
    if [ "$repository" = "$FAKE_SOURCE_REPOSITORY" ]; then
      cp "$FAKE_PRIVATE_ASSETS/livepeer-agent.tgz" "$destination/livepeer-agent.tgz"
      cp "$FAKE_PRIVATE_ASSETS/livepeer-agent.tgz.sha256" "$destination/livepeer-agent.tgz.sha256"
    else
      cp "$FAKE_PUBLIC_ASSETS/livepeer-agent.tgz" "$destination/livepeer-agent.tgz"
      cp "$FAKE_PUBLIC_ASSETS/livepeer-agent.tgz.sha256" "$destination/livepeer-agent.tgz.sha256"
    fi
    ;;
  release:create)
    tag=$1
    archive=$2
    checksum=$3
    cp "$archive" "$FAKE_PUBLIC_ASSETS/livepeer-agent.tgz"
    cp "$checksum" "$FAKE_PUBLIC_ASSETS/livepeer-agent.tgz.sha256"
    printf '%s\n' "$tag" > "$FAKE_CREATE_MARKER"
    ;;
  *) printf 'unexpected fake gh command: %s %s\n' "$command" "$subcommand" >&2; exit 2 ;;
esac
EOF
chmod 755 "$fake_bin/gh" "$fixture/scripts/promote-release.sh"

git -C "$fixture" init -q
git -C "$fixture" add .
git -C "$fixture" -c user.name=test -c user.email=test@example.invalid commit -qm fixture

FAKE_SOURCE_REPOSITORY=source/private \
FAKE_PRIVATE_ASSETS="$private_assets" \
FAKE_PUBLIC_ASSETS="$public_assets" \
FAKE_CREATE_MARKER="$temporary/created" \
LIVEPEER_AGENT_SOURCE_REPOSITORY=source/private \
LIVEPEER_AGENT_PUBLIC_REPOSITORY=public/releases \
GH_BIN="$fake_bin/gh" \
  "$fixture/scripts/promote-release.sh" v0.1.0 >/dev/null

[ "$(cat "$temporary/created")" = v0.1.0 ] || { printf 'promotion did not create expected tag\n' >&2; exit 1; }
cmp "$private_assets/livepeer-agent.tgz" "$public_assets/livepeer-agent.tgz" >/dev/null
cmp "$private_assets/livepeer-agent.tgz.sha256" "$public_assets/livepeer-agent.tgz.sha256" >/dev/null

if FAKE_SOURCE_REPOSITORY=source/private \
  FAKE_PRIVATE_ASSETS="$private_assets" \
  FAKE_PUBLIC_ASSETS="$public_assets" \
  FAKE_CREATE_MARKER="$temporary/unexpected" \
  LIVEPEER_AGENT_SOURCE_REPOSITORY=source/private \
  LIVEPEER_AGENT_PUBLIC_REPOSITORY=public/releases \
  GH_BIN="$fake_bin/gh" \
  "$fixture/scripts/promote-release.sh" v0.2.0 >/dev/null 2>&1; then
  printf 'promotion accepted a tag that did not match the package version\n' >&2
  exit 1
fi

printf 'dirty fixture\n' > "$fixture/untracked"
if FAKE_SOURCE_REPOSITORY=source/private \
  FAKE_PRIVATE_ASSETS="$private_assets" \
  FAKE_PUBLIC_ASSETS="$public_assets" \
  FAKE_CREATE_MARKER="$temporary/unexpected-dirty" \
  LIVEPEER_AGENT_SOURCE_REPOSITORY=source/private \
  LIVEPEER_AGENT_PUBLIC_REPOSITORY=public/releases \
  GH_BIN="$fake_bin/gh" \
  "$fixture/scripts/promote-release.sh" v0.1.0 >/dev/null 2>&1; then
  printf 'promotion accepted a dirty source worktree\n' >&2
  exit 1
fi
rm "$fixture/untracked"

if FAKE_PUBLIC_EXISTS=1 \
  FAKE_SOURCE_REPOSITORY=source/private \
  FAKE_PRIVATE_ASSETS="$private_assets" \
  FAKE_PUBLIC_ASSETS="$public_assets" \
  FAKE_CREATE_MARKER="$temporary/unexpected-overwrite" \
  LIVEPEER_AGENT_SOURCE_REPOSITORY=source/private \
  LIVEPEER_AGENT_PUBLIC_REPOSITORY=public/releases \
  GH_BIN="$fake_bin/gh" \
  "$fixture/scripts/promote-release.sh" v0.1.0 >/dev/null 2>&1; then
  printf 'promotion accepted an existing public release\n' >&2
  exit 1
fi

printf 'promotion validation passed\n'
