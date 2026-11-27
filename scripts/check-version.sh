#!/bin/sh
# Check that the app version agrees in the three places that carry it, and,
# when an expected version is given (the release tag without "v"), that it
# matches that too. Usage: scripts/check-version.sh [expected]
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
expected=${1-}

# First `version = "x"` line inside [workspace.package].
cargo=$(sed -n '/^\[workspace\.package\]/,/^\[/{s/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p;}' "$root/Cargo.toml" | head -n 1)
# First top-level "version": "x" line.
tauri=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/app/src-tauri/tauri.conf.json" | head -n 1)
pkg=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/app/ui/package.json" | head -n 1)

if [ -z "$cargo" ] || [ -z "$tauri" ] || [ -z "$pkg" ]; then
  echo "could not read a version: Cargo.toml='$cargo' tauri.conf.json='$tauri' package.json='$pkg'" >&2
  exit 1
fi

# The reference every file is compared against: the tag if given, else Cargo.toml.
want=${expected:-$cargo}
fail=0
for entry in "Cargo.toml:$cargo" "tauri.conf.json:$tauri" "package.json:$pkg"; do
  name=${entry%%:*}
  have=${entry#*:}
  if [ "$have" != "$want" ]; then
    echo "$name has $have, expected $want" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "version $want"
