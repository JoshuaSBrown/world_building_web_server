#!/usr/bin/env bash
# Generate the server's wire types and routing from api/openapi.yaml.
#
#   scripts/gen-api.sh generate   rewrite src/generated/ from the spec
#   scripts/gen-api.sh check      fail if src/generated/ is stale or missing
#
# The generator is pinned to one exact version and installed into .tools/ beside
# this crate (git-ignored), so a regeneration never depends on whatever happens to
# be on PATH. Upgrading is a deliberate edit of PINNED below, followed by
# `generate`, a review of the diff, and `cargo test`.
set -euo pipefail

PINNED="0.22.0"

here="$(cd "$(dirname "$0")/.." && pwd)"
tools="$here/.tools"
bin="$tools/bin/openapi-to-rust"

if [[ ! -x "$bin" ]] || [[ "$("$bin" --version)" != "openapi-to-rust $PINNED" ]]; then
  echo "installing openapi-to-rust $PINNED into $tools" >&2
  cargo install --locked --quiet openapi-to-rust --version "=$PINNED" --root "$tools"
fi
if [[ "$("$bin" --version)" != "openapi-to-rust $PINNED" ]]; then
  echo "error: $bin is not openapi-to-rust $PINNED" >&2
  exit 1
fi

cd "$here"
case "${1:-}" in
  generate) "$bin" generate --config openapi-to-rust.toml ;;
  check)    "$bin" generate --config openapi-to-rust.toml --check ;;
  *)        echo "usage: $0 generate|check" >&2; exit 2 ;;
esac
