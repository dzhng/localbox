#!/bin/sh
# The CLI's entry: the bundled Node runs the compiled CLI, which finds its skill and skills installer beside itself.
# In the app it is `Contents/Resources/cli/localbox`, beside `dist/`, with Node at `Resources/node/bin/node`. The
# release tarball scripts/release.sh still builds puts it at `localbox-cli/bin/localbox`, with `node` and `dist/` one
# level up; that layout goes when slice 10 of specs/menu-bar-app deletes the tarball.
set -eu
SELF=$0
if [ -L "$SELF" ]; then SELF=$(readlink "$SELF"); fi
HERE=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
if [ -d "$HERE/dist" ]; then exec "$HERE/../node/bin/node" "$HERE/dist/apps/cli/src/index.js" "$@"; fi
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
exec "$ROOT/node" "$ROOT/dist/apps/cli/src/index.js" "$@"
