#!/bin/sh
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
missing=""
for tool in node npm git gh gc bd; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
[ -z "$missing" ] || echo "not on PATH:$missing (the launcher approves only tools it can find)" >&2
gh auth status >/dev/null 2>&1 || echo "gh is not authenticated; run gh auth login before the Pull requests extension can read GitHub" >&2
if ! npm ci --no-audit --no-fund; then
  sdk=$(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX26*.sdk 2>/dev/null | sort | tail -1)
  [ -n "$sdk" ] || { echo "native build failed and no macOS 26 SDK is installed to retry with" >&2; exit 1; }
  echo "retrying the native build with SDKROOT=$sdk" >&2
  SDKROOT="$sdk" npm run install:runtime
fi
npm run build
echo "built $root; start hvir with $root/extensions/dev/host.sh"
