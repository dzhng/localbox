#!/bin/sh
# The CLI's entry, `Contents/Resources/cli/localbox`: the bundled Node (`Resources/node/bin/node`) runs the compiled
# CLI beside it, which finds its skill and skills installer beside itself.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$HERE/../node/bin/node" "$HERE/dist/apps/cli/src/index.js" "$@"
