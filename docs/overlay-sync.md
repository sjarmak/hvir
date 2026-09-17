# Overlay sync: re-basing feat/beads-panel onto an upstream release tag

`feat/beads-panel` on the fork (`sjarmak/hvir`, remote `fork`) is a thin overlay on
Ben's upstream (`jarmak-personal/hvir`, remote `origin`). The overlay is merged
with upstream only at upstream release tags, never at the tip of `main`.

The overlay lives in `src/main/beads`, `src/main/gascity`, `src/renderer/src/beads`,
`src/shared/ipc/*.ts`, `test/`, and `scripts/generate-gascity-supervisor-types.mts`.
Six upstream files carry only wiring lines and are the usual conflict sites:

- `src/renderer/src/App.tsx`
- `src/main/index.ts`
- `src/main/ipc.ts`
- `src/main/ipc/deps.ts`
- `src/shared/ipc.ts`
- `src/main/smoke/index.ts`

Three upstream policy files also carry overlay lines. They conflict rarely, but a
lost hunk here fails a gate rather than a feature, so the loss is easy to
misattribute:

- `package.json` — the `generate:gascity-supervisor-types` script.
- `eslint.config.mjs` — `scripts/generate-gascity-supervisor-types.mts` in the
  contributor-tooling exemption list, which lets a generator read the filesystem.
- `scripts/check-seams.sh` — rule 5 naming `src/main/gascity/supervisor-client.ts`
  as the second `connectLoopback` owner. Take upstream's version and re-add the
  overlay's owner; do not drop the rule to make the check pass.

## Running a sync

```bash
git config rerere.enabled false      # once per clone; the script refuses otherwise
bash scripts/sync-upstream-tag.sh    # newest v* tag
bash scripts/sync-upstream-tag.sh v0.2.3
```

Preflight, all hard failures (exit 2): no uncommitted changes to tracked files
(untracked files do not block unless the tag would write one of them, in which case
the script names the paths and stops before branching); `rerere.enabled` set
explicitly to `false`; remotes `origin` and `fork` configured; `feat/beads-panel`
present locally; an explicit tag argument must be a plain tag name. The script
needs only bash 3.2, so the macOS system bash runs it.
Env overrides `HVIR_SYNC_UPSTREAM_REMOTE`, `HVIR_SYNC_FORK_REMOTE`,
`HVIR_SYNC_OVERLAY_BRANCH`, `HVIR_SYNC_NPM`, `HVIR_SYNC_NPX` exist for the test
fixture only.

The script fetches both remotes, picks the newest `v*` tag by version sort among the
tags `origin` publishes (a local or fork-only tag is never a candidate; pass the tag
explicitly if a pre-release sorts above the release you want), and exits 0 with
"already merged" when the tag is already an ancestor of the overlay branch.
Otherwise it creates `sync/<tag>-<utc timestamp>` off `feat/beads-panel` and runs
`git merge --no-ff <tag>` there. The overlay branch itself is never modified.

## On conflicts

The merge is left in place on the scratch branch and the script exits 1 after
listing the conflicted files in two groups: the six wiring files above, and
everything else. For a wiring file, take the upstream version and re-insert the
overlay's wiring lines by hand; do not reuse a previous resolution. Then commit and
run the gates yourself:

```bash
npm ci && npm run typecheck && npm run lint && npm run check-seams && npm run check-adrs && npx vitest run
```

## On a clean merge

The script runs those same gates one at a time (logs under
`.git/sync-upstream-tag/`) and prints a PASS/FAIL line per gate. `npm run verify`
is not used because it includes `architecture:check`, which needs a GitHub token.
The vitest gate passes when vitest exits 0, or when the only `FAIL` line is the
known pre-existing `LocalHost > removes only the observed version of a file`
(root cause and reproduction recorded in fork issue #10: the guard compares an
exact `mtimeMs` against a `stat` result that can lose sub-millisecond precision,
so it rejects a file nothing changed); a
non-zero exit with any other `FAIL` line, or with no parseable `FAIL` line at all,
is reported as FAIL. The known failure is printed under its own heading so it is not
mistaken for an overlay regression.

The script never pushes and never deletes anything. Merging the scratch branch into
`feat/beads-panel`, and any push to `fork`, are manual steps after review. Delete a
finished scratch branch by typing its literal name, for example
`git branch -d sync/v0.2.3-20260912T120000Z`.

## Why rerere is refused

The v0.2.3 sync ran with `git rerere` enabled. It replayed an earlier
"take upstream" resolution for a wiring file and silently dropped the overlay's
hunks; the merge looked clean and the loss was found later. Every wiring-file
conflict is now resolved by hand, and the script will not start unless
`rerere.enabled` is explicitly `false` (unset is not enough, because git enables
rerere automatically when `.git/rr-cache` exists).

This document and `scripts/sync-upstream-tag.sh` replace the former
`scripts/sync-upstream.sh`, which merged `upstream/main`, relied on rerere, ran
`npm run verify` and pushed.
