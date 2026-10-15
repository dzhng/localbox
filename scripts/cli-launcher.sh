#!/bin/sh
# The release CLI's `bin/localbox`: the bundled Node runs the compiled CLI, which finds its skill and skills installer
# beside itself.
set -eu
SELF=$0
if [ -L "$SELF" ]; then SELF=$(readlink "$SELF"); fi
ROOT=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd)
exec "$ROOT/node" "$ROOT/dist/apps/cli/src/index.js" "$@"
