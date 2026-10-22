#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
profile=${HVIR_DEV_PROFILE:-"$HOME/Library/Application Support/hvir"}
host=${HVIR_DEV_HOST:-"$HOME/hvir-worktrees/main"}
node "$here/install-extensions.mjs" --profile "$profile" --host "$host" --config "$here/install.json"
cd "$host"
exec node ./node_modules/.bin/electron . --user-data-dir="$profile"
