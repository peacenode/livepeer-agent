#!/bin/sh

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=8.30.1
binary=${GITLEAKS_BIN:-}

if [ -z "$binary" ] && command -v gitleaks >/dev/null 2>&1; then
  binary=$(command -v gitleaks)
fi

if [ -z "$binary" ]; then
  platform=$(uname -s)
  architecture=$(uname -m)
  case "$platform/$architecture" in
    Darwin/arm64)
      archive="gitleaks_${version}_darwin_arm64.tar.gz"
      expected="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
      ;;
    Linux/x86_64)
      archive="gitleaks_${version}_linux_x64.tar.gz"
      expected="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
      ;;
    *)
      printf 'Install Gitleaks %s or set GITLEAKS_BIN for %s/%s.\n' "$version" "$platform" "$architecture" >&2
      exit 1
      ;;
  esac

  temporary=$(mktemp -d "${TMPDIR:-/tmp}/livepeer-gitleaks.XXXXXX")
  trap 'rm -rf "$temporary"' EXIT HUP INT TERM
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}" -o "$temporary/$archive"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$temporary/$archive" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$temporary/$archive" | awk '{print $1}')
  fi
  [ "$actual" = "$expected" ] || {
    printf 'Gitleaks archive checksum mismatch.\n' >&2
    exit 1
  }
  tar -xzf "$temporary/$archive" -C "$temporary" gitleaks
  binary="$temporary/gitleaks"
fi

cd "$root"
"$binary" git . --config .gitleaks.toml --redact=100 --no-banner
