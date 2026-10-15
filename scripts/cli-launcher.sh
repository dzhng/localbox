#!/bin/sh
# The release CLI's `bin/localbox`: the bundled Node runs the compiled CLI with the bundled skill and skills installer.
set -eu
SELF=$0
if [ -L "$SELF" ]; then SELF=$(readlink "$SELF"); fi
ROOT=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd)
export LOCALBOX_SKILL_SOURCE="${LOCALBOX_SKILL_SOURCE:-$ROOT/skill}"
export LOCALBOX_NODE_PATH="${LOCALBOX_NODE_PATH:-$ROOT/node}"
export LOCALBOX_SKILLS_INSTALLER="${LOCALBOX_SKILLS_INSTALLER:-$ROOT/skills-installer/bin/cli.mjs}"
exec "$ROOT/node" "$ROOT/dist/apps/cli/src/index.js" "$@"
