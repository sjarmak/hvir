#!/usr/bin/env bash
#
# Re-sync the overlay branch (feat/beads-panel) onto an upstream release tag.
#
# Replaces scripts/sync-upstream.sh. Policy:
#   - merges at upstream release tags only (newest v* tag, or the tag in $1);
#   - refuses to run unless rerere.enabled is explicitly false (the v0.2.3 sync
#     replayed a stale rerere resolution and silently dropped overlay hunks);
#   - works on a scratch branch off the overlay branch, never on the overlay
#     branch itself;
#   - on conflicts, leaves the merge in place for a human and groups the
#     conflicted files into overlay wiring files versus other;
#   - on a clean merge, runs the quality gates one by one (not `npm run
#     verify`, which needs a token for architecture:check);
#   - never publishes anything to a remote and never deletes anything.
#
# Usage: bash scripts/sync-upstream-tag.sh [tag]
set -euo pipefail

UPSTREAM_REMOTE="${HVIR_SYNC_UPSTREAM_REMOTE:-origin}"
FORK_REMOTE="${HVIR_SYNC_FORK_REMOTE:-fork}"
OVERLAY_BRANCH="${HVIR_SYNC_OVERLAY_BRANCH:-feat/beads-panel}"
NPM_BIN="${HVIR_SYNC_NPM:-npm}"
NPX_BIN="${HVIR_SYNC_NPX:-npx}"
KNOWN_FAILURE='LocalHost > removes only the observed version of a file'
WIRING_FILES=(
  src/renderer/src/App.tsx
  src/main/index.ts
  src/main/ipc.ts
  src/main/ipc/deps.ts
  src/shared/ipc.ts
  src/main/smoke/index.ts
)

usage() {
  echo "usage: bash scripts/sync-upstream-tag.sh [tag]" >&2
  echo "  tag defaults to the newest v* tag on $UPSTREAM_REMOTE" >&2
}

die() {
  echo "sync-upstream-tag: $*" >&2
  exit 2
}

if [ "$#" -gt 1 ]; then
  usage
  exit 2
fi
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 2
fi
requested_tag="${1:-}"

repo_root="$(git rev-parse --show-toplevel)"
git_dir="$(git -C "$repo_root" rev-parse --absolute-git-dir)"
log_dir="$git_dir/sync-upstream-tag"

# --- Preflight -------------------------------------------------------------

if [ -n "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ]; then
  die "the tree has uncommitted changes to tracked files; commit or stash them first"
fi

rerere_value="$(git -C "$repo_root" config --type=bool --get rerere.enabled || true)"
if [ "$rerere_value" != "false" ]; then
  echo "sync-upstream-tag: rerere.enabled must be explicitly false; set it with: git config rerere.enabled false" >&2
  echo "  (the v0.2.3 sync lost overlay hunks to a replayed rerere resolution; unset is unsafe because git enables rerere when .git/rr-cache exists)" >&2
  exit 2
fi

git -C "$repo_root" remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 \
  || die "remote '$UPSTREAM_REMOTE' is not configured"
git -C "$repo_root" remote get-url "$FORK_REMOTE" >/dev/null 2>&1 \
  || die "remote '$FORK_REMOTE' is not configured"
git -C "$repo_root" rev-parse --verify --quiet "refs/heads/$OVERLAY_BRANCH" >/dev/null \
  || die "overlay branch '$OVERLAY_BRANCH' does not exist locally"

# --- Fetch (read-only against both remotes) --------------------------------

echo "[fetch] $UPSTREAM_REMOTE (with tags)"
git -C "$repo_root" fetch --quiet --tags "$UPSTREAM_REMOTE"
echo "[fetch] $FORK_REMOTE"
git -C "$repo_root" fetch --quiet "$FORK_REMOTE"

# --- Resolve the tag -------------------------------------------------------

if [ -n "$requested_tag" ]; then
  git -C "$repo_root" rev-parse --verify --quiet "refs/tags/$requested_tag^{commit}" >/dev/null \
    || die "tag '$requested_tag' does not exist after fetching $UPSTREAM_REMOTE"
  tag="$requested_tag"
else
  tag="$(git -C "$repo_root" tag --list 'v[0-9]*' --sort=-version:refname | head -n 1)"
  [ -n "$tag" ] || die "no v* release tags found after fetching $UPSTREAM_REMOTE"
fi

if git -C "$repo_root" merge-base --is-ancestor "$tag" "$OVERLAY_BRANCH"; then
  echo "$tag is already merged into $OVERLAY_BRANCH; nothing to do"
  exit 0
fi

# --- Scratch branch --------------------------------------------------------

scratch="sync/$tag-$(date -u +%Y%m%dT%H%M%SZ)"
if git -C "$repo_root" rev-parse --verify --quiet "refs/heads/$scratch" >/dev/null; then
  die "scratch branch '$scratch' already exists"
fi
echo "[branch] $scratch (from $OVERLAY_BRANCH)"
git -C "$repo_root" switch --quiet -c "$scratch" "$OVERLAY_BRANCH"

# --- Merge -----------------------------------------------------------------

is_wiring_file() {
  local candidate="$1" wiring
  for wiring in "${WIRING_FILES[@]}"; do
    if [ "$candidate" = "$wiring" ]; then
      return 0
    fi
  done
  return 1
}

echo "[merge] $tag into $scratch"
if ! git -C "$repo_root" merge --no-ff --no-edit "$tag"; then
  conflicted="$(git -C "$repo_root" diff --name-only --diff-filter=U)"
  if [ -z "$conflicted" ]; then
    echo "merge failed without conflicts; see git status" >&2
    exit 1
  fi
  wiring_hits=""
  other_hits=""
  while IFS= read -r path; do
    if is_wiring_file "$path"; then
      wiring_hits="$wiring_hits    $path"$'\n'
    else
      other_hits="$other_hits    $path"$'\n'
    fi
  done <<<"$conflicted"
  echo
  [ -n "$wiring_hits" ] || wiring_hits="    (none)"$'\n'
  [ -n "$other_hits" ] || other_hits="    (none)"$'\n'
  echo "Overlay wiring files (take upstream, then re-insert the overlay lines by hand):"
  printf '%s' "$wiring_hits"
  echo "Other conflicted files:"
  printf '%s' "$other_hits"
  echo
  echo "Merge left in place on branch $scratch; resolve, commit, then run the gates by hand."
  exit 1
fi

# --- Gates -----------------------------------------------------------------

mkdir -p "$log_dir"
declare -A gate_status=()
gate_order=()

run_gate() {
  local label="$1"
  shift
  local log="$log_dir/$label.log"
  gate_order+=("$label")
  echo "[gate] $label: running ($*)"
  if (cd "$repo_root" && "$@") >"$log" 2>&1; then
    gate_status["$label"]=0
    echo "[gate] $label: PASS"
  else
    gate_status["$label"]=$?
    echo "[gate] $label: FAIL (exit ${gate_status[$label]}; log $log)"
  fi
}

run_gate ci "$NPM_BIN" ci
run_gate typecheck "$NPM_BIN" run typecheck
run_gate lint "$NPM_BIN" run lint
run_gate check-seams "$NPM_BIN" run check-seams
run_gate check-adrs "$NPM_BIN" run check-adrs

vitest_log="$log_dir/vitest.log"
gate_order+=(vitest)
echo "[gate] vitest: running ($NPX_BIN vitest run)"
vitest_exit=0
(cd "$repo_root" && "$NPX_BIN" vitest run) >"$vitest_log" 2>&1 || vitest_exit=$?

fail_lines="$(grep -E '^[[:space:]]*(FAIL|×|✗)' "$vitest_log" || true)"
known_lines="$(printf '%s\n' "$fail_lines" | grep -F "$KNOWN_FAILURE" || true)"
unexpected_lines="$(printf '%s\n' "$fail_lines" | grep -vF "$KNOWN_FAILURE" | grep -v '^$' || true)"
vitest_note=""
if [ "$vitest_exit" -eq 0 ]; then
  gate_status[vitest]=0
elif [ -n "$known_lines" ] && [ -z "$unexpected_lines" ]; then
  gate_status[vitest]=0
else
  gate_status[vitest]="$vitest_exit"
  if [ -z "$fail_lines" ]; then
    vitest_note="vitest exited $vitest_exit with no parsed failures; see $vitest_log"
  fi
fi
if [ "${gate_status[vitest]}" -eq 0 ]; then
  echo "[gate] vitest: PASS"
else
  echo "[gate] vitest: FAIL (exit $vitest_exit; log $vitest_log)"
fi

# --- Summary ---------------------------------------------------------------

echo
echo "Summary for $tag on $scratch"
all_passed=1
for label in "${gate_order[@]}"; do
  if [ "${gate_status[$label]}" -eq 0 ]; then
    echo "  $label: PASS"
  else
    echo "  $label: FAIL"
    all_passed=0
  fi
done
if [ -n "$vitest_note" ]; then
  echo "  $vitest_note"
fi
if [ -n "$known_lines" ]; then
  echo "Known pre-existing failure (not an overlay regression):"
  printf '%s\n' "$known_lines" | sed 's/^/    /'
fi
if [ -n "$unexpected_lines" ]; then
  echo "Unexpected test failures:"
  printf '%s\n' "$unexpected_lines" | sed 's/^/    /'
fi
echo "Logs: $log_dir"
echo "Scratch branch: $scratch (not pushed). Merge into $OVERLAY_BRANCH by hand once reviewed."

if [ "$all_passed" -eq 1 ]; then
  exit 0
fi
exit 1
