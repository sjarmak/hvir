# Handoff: Gas City crew view — lag on workspace tab switching

**Branch:** `feat/beads-panel` · **Written:** 2026-07-19 · **Revised:** 2026-07-19 after measuring

## Symptom

The app is "super laggy" when swapping between workspace tabs, reported after the Gas City
crew view landed.

## Measurements (2026-07-19)

Taken on the gc host itself (`work` = `ds-5090`, the SSH host every workspace in
`projects.json` lives on), city of ~22 rigs and ~73 sessions. Three runs each.

**Which gc these describe:** `~/.local/bin/gc` → `~/go/bin/gc`, whose embedded build stamp
(`go version -m`) reads `-X main.commit=2f57a364e -X main.date=2026-07-19T20:46:03Z`. That
commit is `/home/ds/gascity-main` sitting exactly on `origin/HEAD` — current upstream main,
0 behind and 0 ahead. So these are timings of upstream gascity, not of a local branch.

Read that stamp; do not infer it from a checkout. There are ~20 gascity trees on that host
(`gascity`, `gascity-main`, `gascity-pr-4075-…`, `gascity-wt-3407`, …), most of them stale
PR-check branches, and the name that looks canonical is not the one that builds the binary.
The binary is also rebuilt roughly hourly by the city's own agents, so its mtime and size
move under you mid-investigation; any timing worth quoting carries its commit.

| what | result |
| --- | --- |
| ICMP RTT to the host | **9.8 ms**, 0% loss |
| `ssh work true`, full connect | 0.25 s |
| remote `bash -lc true` | **0.00 s** |
| remote `true`, `git status --porcelain` | **0.00 s** |
| remote `bd ready --json`, `bd list --json` | **0.03–0.05 s** |
| `gc config show` | **0.25 / 0.26 / 0.27 s** (123 KB out) |
| `gc rig list --json` | **2.70 / 2.75 / 2.88 s** (3.7 KB out) |
| `gc session list --json` | **2.4 / 3.0 / 2.3 s** (61 KB out) |

Host load average was 23 / 28 / 75 on 16 cores while these ran, and `git status` still
returned instantly — so the machine being busy is not the explanation either.

### What that overturns

- **Not the network.** 9.8 ms RTT, no loss, and the same connection runs git in zero time.
- **Not the login shell.** `bash -lc true` costs nothing; `loginShell: true` is free.
- **`gc config show` was never the problem.** It is the *cheapest* of the three gc calls by
  an order of magnitude. `3aa83df` cached it — correct in principle, aimed at the wrong
  command. The original H1 (split the context cache) is therefore worth much less than it
  looked, and only for `rig list`.
- **The two cheap-looking commands cost seconds.** `gc session list` sits on the 4-second
  poll and cannot be cached away; `gc rig list` is on the cold path of every context load.

### Why it reads as whole-app lag

`SSH_DEFAULT_MAX_CONCURRENT_EXECS` is 4, and that budget is shared by git discovery and
status, harness telemetry, `bd`, and `gc`. A 3-second poll on a 4-second timer holds one of
four slots most of the time. Switch a workspace tab and `gc rig list` + `gc config show` +
`gc session list` + five `bd` calls all pile onto the same budget, so the new workspace's
git status queues behind roughly six seconds of gc. gc is about sixty times slower than
everything else hvir runs on that host.

## Done

**Reserve a background exec lane** (`src/main/project-host/ssh-exec-slots.ts`). `ExecOptions`
gained `lane?: 'interactive' | 'background'`; `SSH_MAX_BACKGROUND_EXECS` is 1, so background
work can never hold more than one of the four slots. The queue passes over a waiting
background exec rather than letting it block interactive work behind it. `GasCityService.run`
passes `lane: 'background'` on every gc call. The scheduler moved out of `ssh-host.ts` into
its own module (that file dropped from 1192 to 1098 lines).

Tests: `test/ssh-exec-slots.test.ts` (lane rules) and one wiring test in
`test/ssh-host.test.ts`. `npm run verify` green.

`bd` stays on the interactive lane deliberately — at 40 ms it is not a contention source,
and putting it behind gc would only make the bead list slower.

**Share every gc read per host** (`src/main/gascity/gascity-host-cache.ts`). All three are
city-wide: `gc session list` ignores `--rig`, `gc rig list` describes the whole city, and
`gc config show` is the city's composed config. The only per-workspace fact is which rig it
maps to, and `rigForPath` derives that from the shared rig list with no IO. `HostReadCache`
holds sessions for 3 s and the other two for 60 s, sharing the in-flight read in all three
cases. **Switching workspaces on a warm host now costs no `gc` at all** — only the marker
stats that locate the city.

The key is the **host**, not the city, and that is forced: gc resolves the city from the
working directory through its machine-wide registry, and hvir learns it only from
`gc rig list` — one of the reads being cached. Keying by a peeked context was tried and
abandoned: it never shares on the first visit to a workspace, which is the case that hurts.
`attribute()` records the city after the fact and drops a read attributed to two different
cities, so a second city on one host costs a repeat read rather than showing the wrong crew.
`GasCityContextCache.peek` was added for this ordering problem.

Two related fixes came with it: the rig/config loaders now throw so a failure evicts instead
of caching emptiness host-wide (`degradeTo` at the call site keeps the workers-only fallback),
and `GasCityContextCache` re-inserts on a hit so its eviction is least-recently-*used* rather
than insertion-ordered — it had been dropping the workspace you keep returning to.

**Let the host set the poll period** (`beads-refresh.ts`). Rather than raising the 4-second
constant to another guess, `createVisibilityRefresh` now chains: refresh, measure, wait a
multiple of what that refresh actually cost (5x, capped at 30 s), repeat. A 3-second read
settles at 15 s; a fast local gc keeps the 4-second floor. A poll can no longer overlap its
own successor either, which the old fixed interval allowed and the `inFlight` guard merely
swallowed.

**Gate the city probe on visibility** (original H2). `BeadsPanel` stays mounted behind the
Files and Git tabs, so the probe's marker walk ran on every workspace switch for a section
the user may never open. It now waits until the section is on screen, and `probedRoot` keeps
a hide/show cycle from asking again. `test/use-gascity-crew.test.tsx` covers it with the
happy-dom harness the repo already uses for `PaneResizer`.

## Remaining

Everything on hvir's side is done. hvir hides the cost rather than removing it: a workspace
switch on a warm host is free, but the first read after a 60 s idle still takes three
seconds, and nothing on this side can change that.

**`gc session list --json` at ~2.5 s for 73 sessions is the actual defect**, and `gc rig
list --json` at ~2.3 s for 3.7 KB of output is the same story. Both are reproducible against
current upstream main (`2f57a364e`), on a host where `true`, `git status --porcelain`, and
`bd list --json` all return in under 50 ms — so it is gc's own cost, not the machine and not
the link (9.8 ms RTT). Worth raising at `github.com/gastownhall/gascity` with the table
above, the commit, and the city's shape (~22 rigs, ~73 sessions).

Note that issue #1 step 5's projection PR does *not* address it: that removes
`gc config show`, the one command already measured cheap.

## Constraints to respect

- `npm run verify` must stay green (750 tests, seam checks, ADR checks, module budgets).
- New production modules cap at 500 lines; named hotspot budgets live in
  `scripts/architecture-hotspots.json` and are asserted by `test/architecture-hotspots.test.ts`.
- All process/filesystem access goes through `ProjectHost` — never `child_process` or `fs`
  directly (`scripts/check-seams.sh` enforces this).
- `loginShell: true` on every `gc` call is load-bearing: `gc` lives in `~/.local/bin`, which a
  non-login SSH exec does not have on `PATH`. It is also free — see the table.

## Map of the area

- `src/main/gascity/COMPASS.md` — **read this first.** Now carries the timings above and the
  background-lane rule.
- `src/main/project-host/COMPASS.md` — the exec-budget and lane reasoning.
- `gascity-service.ts` — orchestration, `gc` invocation, city/rig resolution.
- `gascity-context.ts` — the per-workspace derivation left after the reads moved out.
- `gascity-host-cache.ts` — the shared reads and why their key is the host.
- `use-gascity-crew.ts` / `beads-refresh.ts` — probe gating and the cost-driven poll period.

## Known-good behaviour to avoid regressing

- City workspace shows every rig lead pinned plus all active workers; the mayor sorts first.
- A rig workspace shows only that rig's lead and workers, plus the mayor.
- Repeat clicks on a card focus the existing terminal instead of opening another.
- The crew section states when the config yielded zero pinned identities, and names
  unclassified sessions.

## Open work unrelated to lag

- Issue #1 step 4b: per-identity harness profiles ("Gas City: mayor") on
  `customCommandProvider`.
- Issue #1 step 5: upstream gc PR projecting `rig`, `pool`, `configured_named_session`,
  `session_origin`, `active_bead` into `gc session list --json`.
