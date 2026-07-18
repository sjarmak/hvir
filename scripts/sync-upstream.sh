#!/usr/bin/env bash
#
# Sync this personal integration branch (beads viewer + custom integrations)
# with the latest official upstream, verify, and push.
#
# It merges upstream/main into the current branch — non-destructive, no force
# push. `git rerere` (enabled in this repo) replays the recurring shared-file
# conflict resolutions (ipc.ts / App.tsx wiring), so after the first time those
# resolve themselves. Safe to run as often as you like.
#
# Contributing fixes back to upstream is a separate flow: branch off
# upstream/main, cherry-pick your fix, and open a PR against jarmak-personal/hvir.
#
# Overridable via env: HVIR_UPSTREAM_REMOTE (default "upstream"),
# HVIR_UPSTREAM_BRANCH (default "main"). Pass --no-verify to skip the checks.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM_REMOTE="${HVIR_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${HVIR_UPSTREAM_BRANCH:-main}"
RUN_VERIFY=1
[ "${1:-}" = "--no-verify" ] && RUN_VERIFY=0

# A merge needs a clean tree; refuse otherwise so nothing is lost.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ You have uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

echo "→ Fetching ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}…"
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

if git merge-base --is-ancestor "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" HEAD; then
  echo "✓ ${BRANCH} already contains ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}. Nothing to merge."
else
  echo "→ Merging ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} into ${BRANCH}…"
  if ! git merge --no-edit "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"; then
    # rerere replays known resolutions and stages them. If nothing is left
    # unmerged, finalize the merge commit; otherwise stop for a one-time resolve.
    if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
      echo "" >&2
      echo "✗ Conflicts need a one-time manual resolution:" >&2
      git diff --name-only --diff-filter=U | sed 's/^/    /' >&2
      echo "" >&2
      echo "  These are almost always 'keep both' edits in ipc.ts / App.tsx." >&2
      echo "  Resolve, 'git add' them, then 'git commit'. rerere records the" >&2
      echo "  resolution so the next sync is automatic. Re-run this script to" >&2
      echo "  verify + push." >&2
      exit 1
    fi
    echo "  (rerere resolved the recurring conflicts automatically.)"
    git commit --no-edit
  fi
fi

if [ "$RUN_VERIFY" -eq 1 ]; then
  echo "→ Verifying (check-seams, lint, typecheck, tests)…"
  npm run verify
else
  echo "→ Skipping verify (--no-verify)."
fi

echo "→ Pushing ${BRANCH} to origin…"
git push origin "$BRANCH"

echo "✓ ${BRANCH} now includes the latest ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} — verified and pushed."
