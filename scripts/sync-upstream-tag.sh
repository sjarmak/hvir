#!/usr/bin/env bash
#
# Re-sync the overlay branch (feat/beads-panel) onto an upstream release tag.
#
# Replaces scripts/sync-upstream.sh. Policy:
#   - merges at upstream release tags only (newest v* tag, or the v* tag in
#     $1, which must exist on the upstream remote at the same commit);
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

# --- Explicit tag: must be a release the upstream remote publishes ----------

# The commit a tag names on the upstream remote, peeled through an annotated
# tag; empty when the remote has no such tag. One ls-remote, no fetch.
upstream_tag_commit() {
  local name="$1" peeled plain
  peeled="$(git -C "$repo_root" ls-remote --tags "$UPSTREAM_REMOTE" "refs/tags/$name^{}" \
    | awk '{ print $1 }' | head -n 1)"
  if [ -n "$peeled" ]; then
    printf '%s\n' "$peeled"
    return 0
  fi
  plain="$(git -C "$repo_root" ls-remote --tags --refs "$UPSTREAM_REMOTE" "refs/tags/$name" \
    | awk '{ print $1 }' | head -n 1)"
  printf '%s\n' "$plain"
}

# Refuse before any fetch: a local tag that disagrees with upstream would also
# make `fetch --tags` fail, with a message that names neither tag nor cause.
expected_commit=""
if [ -n "$requested_tag" ]; then
  git check-ref-format "refs/tags/$requested_tag" \
    || die "'$requested_tag' is not a valid tag name"
  case "$requested_tag" in
    v[0-9]*) ;;
    *) die "'$requested_tag' is not a v* release tag; the overlay merges at upstream releases only" ;;
  esac
  expected_commit="$(upstream_tag_commit "$requested_tag")"
  [ -n "$expected_commit" ] \
    || die "tag '$requested_tag' is not published on $UPSTREAM_REMOTE (a local-only or fork-only tag is not a release)"
  local_commit="$(git -C "$repo_root" rev-parse --verify --quiet "refs/tags/$requested_tag^{commit}" || true)"
  if [ -n "$local_commit" ] && [ "$local_commit" != "$expected_commit" ]; then
    die "local tag '$requested_tag' differs from $UPSTREAM_REMOTE ($local_commit vs $expected_commit); delete the local tag by name and retry"
  fi
fi

# --- Fetch (read-only against both remotes) --------------------------------

echo "[fetch] $UPSTREAM_REMOTE (with tags)"
git -C "$repo_root" fetch --quiet --tags "$UPSTREAM_REMOTE" \
  || die "fetching $UPSTREAM_REMOTE failed; a local tag that differs from the upstream tag of the same name must be deleted by name first"
echo "[fetch] $FORK_REMOTE"
git -C "$repo_root" fetch --quiet "$FORK_REMOTE"

# --- Resolve the tag -------------------------------------------------------

if [ -n "$requested_tag" ]; then
  local_commit="$(git -C "$repo_root" rev-parse --verify --quiet "refs/tags/$requested_tag^{commit}" || true)"
  [ -n "$local_commit" ] \
    || die "tag '$requested_tag' does not exist after fetching $UPSTREAM_REMOTE"
  [ "$local_commit" = "$expected_commit" ] \
    || die "local tag '$requested_tag' differs from $UPSTREAM_REMOTE ($local_commit vs $expected_commit); delete the local tag by name and retry"
  tag="$requested_tag"
else
  # Candidates are the tags the upstream remote actually publishes: a local or
  # fork-only v* tag that sorts higher must not be mistaken for a release.
  upstream_tags="$(git -C "$repo_root" ls-remote --tags --refs "$UPSTREAM_REMOTE" 'refs/tags/v[0-9]*' \
    | sed 's|.*refs/tags/||')"
  [ -n "$upstream_tags" ] || die "no v* release tags found on $UPSTREAM_REMOTE"
  tag="$(git -C "$repo_root" tag --list 'v[0-9]*' --sort=-version:refname \
    | grep -Fx -f <(printf '%s\n' "$upstream_tags") | head -n 1 || true)"
  [ -n "$tag" ] || die "no v* release tags found locally after fetching $UPSTREAM_REMOTE"
fi

if git -C "$repo_root" merge-base --is-ancestor "$tag" "$OVERLAY_BRANCH"; then
  echo "$tag is already merged into $OVERLAY_BRANCH; nothing to do"
  exit 0
fi

# An untracked file the tag would write makes git abort the merge after the
# scratch branch exists; refuse up front instead, naming the paths.
blocking_untracked="$(comm -12 \
  <(git -C "$repo_root" diff --name-only "$OVERLAY_BRANCH" "$tag" | sort) \
  <(git -C "$repo_root" ls-files --others --exclude-standard | sort))"
if [ -n "$blocking_untracked" ]; then
  echo "sync-upstream-tag: untracked files would be overwritten by $tag; move or commit them first:" >&2
  printf '%s\n' "$blocking_untracked" | sed 's/^/    /' >&2
  exit 2
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
    git -C "$repo_root" switch --quiet "$OVERLAY_BRANCH"
    echo "merge failed without conflicts; see the git output above" >&2
    echo "back on $OVERLAY_BRANCH; scratch branch $scratch is unused and can be deleted by name" >&2
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
# Parallel indexed arrays rather than an associative one: macOS ships bash 3.2.
gate_order=()
gate_results=()

record_gate() {
  gate_order+=("$1")
  gate_results+=("$2")
}

run_gate() {
  local label="$1"
  shift
  local log="$log_dir/$label.log"
  local status=0
  echo "[gate] $label: running ($*)"
  (cd "$repo_root" && "$@") >"$log" 2>&1 || status=$?
  record_gate "$label" "$status"
  if [ "$status" -eq 0 ]; then
    echo "[gate] $label: PASS"
  else
    echo "[gate] $label: FAIL (exit $status; log $log)"
  fi
}

run_gate ci "$NPM_BIN" ci
run_gate typecheck "$NPM_BIN" run typecheck
run_gate lint "$NPM_BIN" run lint
run_gate check-seams "$NPM_BIN" run check-seams
run_gate check-adrs "$NPM_BIN" run check-adrs

vitest_log="$log_dir/vitest.log"
echo "[gate] vitest: running ($NPX_BIN vitest run)"
vitest_exit=0
(cd "$repo_root" && "$NPX_BIN" vitest run) >"$vitest_log" 2>&1 || vitest_exit=$?

# Only the "Failed Tests" summary lines (` FAIL  <file> > <suite> > <test>`)
# carry the full test name; the per-test tree line (`× <test> 9ms`) does not,
# so matching it would mark the known failure as unexpected on every run. The
# known name is anchored at the end of the line so a longer name that merely
# starts with it is still unexpected.
known_re="$(printf '%s' "$KNOWN_FAILURE" | sed 's/[][\\.*^$|+?(){}]/\\&/g')"
fail_lines="$(grep -E '^[[:space:]]*FAIL[[:space:]]' "$vitest_log" || true)"
known_lines="$(printf '%s\n' "$fail_lines" | grep -E "> $known_re[[:space:]]*\$" || true)"
unexpected_lines="$(printf '%s\n' "$fail_lines" | grep -vE "> $known_re[[:space:]]*\$" | grep -v '^$' || true)"
vitest_note=""
vitest_status="$vitest_exit"
if [ "$vitest_exit" -eq 0 ]; then
  vitest_status=0
elif [ -n "$known_lines" ] && [ -z "$unexpected_lines" ]; then
  vitest_status=0
elif [ -z "$fail_lines" ]; then
  vitest_note="vitest exited $vitest_exit with no parsed failures; see $vitest_log"
fi
record_gate vitest "$vitest_status"
if [ "$vitest_status" -eq 0 ]; then
  echo "[gate] vitest: PASS"
else
  echo "[gate] vitest: FAIL (exit $vitest_exit; log $vitest_log)"
fi

# --- Summary ---------------------------------------------------------------

echo
echo "Summary for $tag on $scratch"
all_passed=1
index=0
for label in "${gate_order[@]}"; do
  if [ "${gate_results[$index]}" -eq 0 ]; then
    echo "  $label: PASS"
  else
    echo "  $label: FAIL"
    all_passed=0
  fi
  index=$((index + 1))
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
