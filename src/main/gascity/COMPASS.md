---
compass_area: "gascity — read-only gc crew bridge (fork-only)"
area_path: "src/main/gascity/"
generated: "2026-07-19"
# Staleness stamp — machine-readable so a refresh can test drift without a model.
# `sources` are area-relative paths (relative to THIS file's directory). Recompute:
#   node ~/.claude/skills/project-compass/compass-hash.mjs src/main/gascity/COMPASS.md
sources_hash: "sha256-16:c6bd71b5c3bc16ed"
sources:
  - gascity-service.ts
  - gascity-context.ts
  - gascity-host-cache.ts
  - gascity-parse.ts
  - gascity-config.ts
  - gascity-crew.ts
  - gascity-owner.ts
  - ../ipc/features/gascity.ts
  - ../../shared/gascity.ts
  - ../../renderer/src/beads/crew-model.ts
  - ../../renderer/src/beads/gascity-commands.ts
  - ../../renderer/src/beads/use-gascity-crew.ts
  - ../../renderer/src/beads/CrewSection.tsx
---

# Compass: gascity — read-only gc crew bridge (fork-only)

> Tribal-knowledge map for `src/main/gascity/` **and its renderer half** (the crew
> section inside the Beads rail). The *why* and the *gotchas* — not the *what*.

## Purpose

The Beads panel used to show a live agent only as an `@owner` chip. This area answers the
question the chip could not: **who is the crew of this rig right now?** The workspace's
pinned lead identities first — rendered even when dormant — then the live worker pools,
each clickable into the terminal and restartable from it. Tier changes a card's
prominence, not what you can do to the session behind it: every card carries the same
four actions, because "which sessions may I reset" is not a question the tiering answers.

It is shaped exactly like the beads bridge (see `src/main/beads/COMPASS.md`): a service
behind `ProjectHost`, pure parsing beside it, an owner module keeping the composition
root to one line, and a self-contained renderer half. Copy that shape, not this file's
specifics.

## What counts as a lead (verified against gc, not our aliases)

gc has **no role or label field** on an agent or a named session. The one concept that
unifies leads across every city is structural:

> A pinned identity is a configured named session with `mode = "always"` that is not
> suspended, associated with the workspace's rig.

`*-pl` naming is a convention of one city, not an anchor — never key off it. Filtering
suspended entries also dedupes the common two-generation situation for free: a
pack-stamped lead that a rig override suspended drops out, leaving the hand-defined one.

## Key files & entry points

- **`gascity-service.ts`** — the whole main-process surface: `crew` / `probe`. Every `gc`
  invocation goes through `ProjectHost.exec`, so the crew view works over SSH.
- **`gascity-parse.ts`** — defensive normalization of `gc session list --json` and
  `gc rig list --json`, plus `rigForPath`. gc's output shape is not ours to control.
- **`gascity-config.ts`** — structural extraction from the resolved city TOML: which named
  sessions are pinned, which agents are multi-session.
- **`gascity-crew.ts`** — the tiering itself. Every rule is structural; nothing keys off a
  naming convention.
- **`src/renderer/src/beads/gascity-commands.ts`** — the gc command vocabulary
  (attach / peek / reset / handoff) and the one place a target is shell-quoted.
- **`src/renderer/src/beads/crew-model.ts`** — the bead join and tier grouping, pure.

## How it connects

- **In:** the crew section inside `BeadsPanel` over IPC (`gascity:crew`, `gascity:probe`).
- **Out:** `ProjectHost.exec` (`gc session list`, `gc rig list`, `gc config show`) and
  `ProjectHost.stat` for the city probe.
- **Sideways:** card clicks become `TerminalAttachRequest`s. `attach` carries an identity
  key so a repeat click *focuses* the terminal already showing that session; peek, reset,
  and handoff are unkeyed one-shot commands that always get a fresh shell
  (`resolveTerminalAttach` in `terminal-workspace-model.ts`).

## Gotchas & non-obvious constraints

- **Scope depends on whether the workspace *is* the city.** The orchestration workspace
  shows the whole city — every rig's lead pinned and every active worker — because that is
  the one place you want it. A rig workspace narrows to that rig's lead and workers plus the
  city's own lead; other rigs' leads, other rigs' workers, and the city's worker pools all
  drop out. `findCityRoot` answers "is this
  the city" with a marker walk, so no rig is recognized by name.
- **The city is found through `gc rig list`, not the filesystem walk.** `gc rig list`
  reports the HQ rig — the city itself — alongside every registered rig, so `resolveCity`
  asks which listed rig root carries `city.toml`. Rigs are *external project directories*
  and often live outside the city, where walking up from the workspace never reaches it; on
  that path the city root came back undefined and the mayor silently vanished from every rig
  crew. The walk survives only as the fallback for when the rig list is unavailable, and
  when no city root resolves at all the scope rule turns permissive on purpose — an extra
  lead is a visible annoyance, a missing mayor looks like the whole view is broken.
- **`city.toml` marks the city root; `.gc` does not.** gc creates a `.gc` directory inside
  every registered rig. Treating it as a city marker made every rig workspace look like the
  orchestration workspace, so the whole city's workers showed up everywhere. Membership
  ("am I in a city", used by the probe) and identity ("am I *the* city") are different
  questions and use different markers — `CITY_MEMBER_MARKERS` vs `CITY_ROOT_MARKER`.
- **`GasCityCrew.scope` is surfaced in the header** for exactly that reason: a wrong scope is
  otherwise invisible, it just looks like too many cards.
- **`cityLead` is one fact serving three jobs.** "Belongs to the city, not to a rig" decides
  scope in a rig workspace, sorts the mayor to the head of the crew in the city workspace,
  and marks the card visually. Deriving it once on the member keeps those three from drifting
  apart — an earlier version recomputed the scope test inline and could rank a card it had
  already filtered differently.
- **`GasCityCrew.diagnostics` is the standing answer to this whole class of bug.** Every
  failure in this area has been a rule deciding quietly on data that was not there, and a
  config key read under the wrong name yields zero pinned identities while looking exactly
  like a city that has none. The panel now states the pinned count when it is zero and names
  the in-scope sessions no config entry describes. Keep it: the alternative is another
  round-trip through a bug report to learn what the derivation already knew.
- **City scope is `work_dir` *equal to* the city root, not under it.** In a nested layout
  every rig is under the city root too, so containment would classify everything as city
  scope. Exact equality is what separates the mayor from a rig's project lead, and it holds
  without knowing either name. The HQ rig is identified the same structural way: the rig
  whose own root carries the city marker.
- **Rig association** is `work_dir` at or under the rig root, or gc's `rig` field, or a
  rig-qualified template. The `rig` field alone would miss city-scope leads, so `work_dir`
  matching stays in the rule regardless of the data source.
- **"The mayor" is the pinned identity rooted *at the city*, and nothing else works.** The
  trap: a rig's hand-defined project lead is a **city-scope** named session carrying no
  `rig` key at all — its rig association lives only in `work_dir`, pointing at the rig root.
  So "has no rig" pins every rig's lead into every workspace, which is exactly the bug that
  shipped twice. The rule that holds: with no rig on either side, compare the identity's
  root against the city root. `identityRoot` prefers the live session's `work_dir` and falls
  back to the configured `work_dir` on the named session or its backing agent, so dormant
  leads scope the same way live ones do. Keying off the literal name `mayor` would be the
  naming convention this design refuses.
- **`[[named_session]]` is keyed by `template`, not `name`.** Most entries carry no `name`
  at all. Requiring one dropped every named session, which silently meant "no leads exist" —
  no mayor, no pins, everything a worker. Identity is `template`; `name` is the exception.
- **An agent names its rig with `dir`; `scope = "city"` agents have none.** The same agent
  name recurs once per rig (`codex`, `core.control-dispatcher`), so a name alone never
  identifies one — always disambiguate by rig before reading `poolName`.
- **A rig lead is declared at city scope and gets its rig through its agent.**
  `[[named_session]] template = "aoa-pl"` has no `dir`; the `[[agent]] name = "aoa-pl"` it
  names carries `dir = "aoa"`. `withAgentRig` closes that link at parse time. Without it
  every rig lead reads as rig-less, which the scope rule treats as "the city's own lead".
- **Sessions are named with the rig's absolute path baked in**
  (`/home/ds/projects/mem/mem-worker-2`), and that prefix is the most reliable rig signal:
  a pooled worker's `work_dir` is frequently a *worktree*
  (`/home/ds/gascity-worktrees/polecat-3`) that lives nowhere near its rig, so containment
  alone loses it. An absolute prefix settles association both ways; a relative qualifier
  (`mem/agent`) names a rig rather than a directory and is matched against the rig name.
- **Those paths are not display text.** Cards label with the basename, and `gc session
  <verb>` targets the session id whenever the alias is path-shaped — a path-shaped alias is
  fragile on a command line. The bead join keeps *both* forms as identity keys, since a bead
  may be assigned either way.
- **A named session need not run under its configured name.** A lead configured as
  `project-lead` can run as `mem-pl`, so matching sessions to config by name/alias alone
  silently demotes leads to workers. The agent template is the fallback link, restricted to
  non-pooled agents so a pool member can never be promoted by sharing a template.
- **A crew refresh has a fast half and a slow half, and only the fast half may poll.**
  The session list is live and re-read every tick (3 s share window). The city's shape —
  rigs, city root, resolved config — changes when someone edits config, i.e. never on a
  4-second timescale, and is held for 60 s. An explicit refresh passes `refresh: true` and
  drops both; the poll never does.
- **All three `gc` reads are city-wide, so all three are shared per host.** `gc session
  list` ignores `--rig`, `gc rig list` describes the whole city, and `gc config show` is the
  city's composed config. The *only* per-workspace fact is which rig it maps to, and
  `rigForPath` derives that from the shared rig list with no IO. That is why switching
  workspaces on a warm host costs no `gc` at all — the previous per-workspace keying re-paid
  every read, seconds each.
- **The key could not be the city, only the host.** gc resolves the city from the working
  directory through its machine-wide registry, and hvir learns it only from `gc rig list` —
  one of the reads being cached. So `HostReadCache` keys by host and `attribute()` records
  the city afterwards, once `crew` has resolved a context; a read attributed to two
  different cities is dropped rather than served. Do not "fix" the key to the city without
  solving that ordering problem first: the naive version deadlocks the reads against each
  other, and the version that peeks a cached context never shares on the first visit to a
  workspace, which is exactly the case that hurts.
- **`GasCityContextCache.peek` exists for that ordering problem** and nothing else. It
  returns a context only if one is already resolved and fresh, so a caller that needs the
  city root to decide *how* to fetch something degrades instead of stalling.
- **A failed read is thrown, not defaulted, and the degrading happens at the call site.**
  A missing rig list still yields a workers-only crew rather than a blank section — that is
  deliberate — but if the loader returned `[]` the cache would hold that emptiness for a
  minute for *every* workspace on the host. `loadRigs` / `loadConfig` throw so the entry
  evicts; `degradeTo` in `loadContext` supplies the fallback and logs.
- **The poll period is a floor the host raises, not a schedule.** What a refresh costs is a
  property of the host: the same `gc session list` returns in milliseconds locally and in
  about three seconds against a real city over SSH. A fixed 4-second interval left the
  reader permanently mid-read. `createVisibilityRefresh` now chains — refresh, measure, wait
  a multiple of what that cost, repeat — so a fast host keeps the configured period and a
  slow one backs off to a cap without a constant here having to guess which it is. It also
  means a poll can no longer overlap its own successor.
- **The city probe waits for the section to be on screen.** `BeadsPanel` stays mounted
  behind the Files and Git tabs, so an ungated probe walked up to a dozen directory levels —
  one SSH round trip each — on every workspace switch, for a section the user may never
  open. The answer holds as long as the workspace does, so `probedRoot` also stops a
  hide/show cycle from asking again.
- **The context cache re-inserts on a hit** so its eviction is least-recently-*used*. A Map
  evicts in insertion order, and without the re-insert the workspace you keep returning to
  is dropped while one abandoned long ago survives.
- **Record which gc a timing describes.** The measurements below came from a build 1921
  commits behind upstream on a PR-checking branch with local edits. That is the right binary
  for sizing *hvir's* problem, because it is the one on the login-shell PATH — and the wrong
  one to cite in a gc bug report. A timing without its build is not evidence.
- **Measure gc before optimizing around it; the costs are not where they look.** On a real
  city (~22 rigs, ~73 sessions, 2026-07-19), timed on the host itself: `gc session list
  --json` **2.3–3.3 s**, `gc rig list --json` **2.7–2.9 s**, `gc config show` **0.25 s**.
  The intuition that `config show` is the expensive one — it re-composes every include,
  pack, patch, and override and emits 123 KB of TOML — is wrong by an order of magnitude,
  and the caching above was originally justified by it. The two commands that actually cost
  seconds are the small ones. For scale, `bd` and `git status` on the same host return in
  **under 50 ms**, so gc is roughly sixty times slower than everything else hvir runs.
- **gc runs on the background exec lane, and that is containment, not tuning.** A host's
  buffered-exec budget is shared by git, harness probes, and every panel
  (`SSH_DEFAULT_MAX_CONCURRENT_EXECS` is 4). A three-second poll on a four-second timer
  holds most of it, and the git discovery a user is waiting on after a workspace switch
  queues behind gc — which reads as the whole app being slow rather than one panel being
  slow. Every `gc` call passes `lane: 'background'`, capping gc at one slot. Do not drop it
  to make a cold crew load faster: the point is that a slow city costs the crew section its
  own latency and nothing else's.
- **Rig marker stats run concurrently.** A city has tens of rigs and each stat is a round
  trip over SSH; sequential probing was the first-load cost.
- **`gc status --json` is disqualified.** Its runtime probe has taken over 120 s to return
  partial data. Never put it on a refresh path.
- **The global `--rig` flag does not filter `gc session list`.** It returns every session
  in the city; the filtering is ours to do.
- **Two data-source generations, one code path.** `hasProjectedTierFields` detects whether
  gc already projects `pool` / `configured_named_session`. When it does, hvir uses them
  verbatim and **skips the config read entirely**; when it does not, the resolved config
  supplies the tiering. `GasCityCrew.tierSource` tells the UI which ran, and the panel says
  so rather than implying gc classified the crew itself.
- **The resolved-config walk is deliberately shape-tolerant.** `named_session` arrays and
  `agents` tables appear at both city and rig scope and have moved between gc versions, so
  the walk finds them wherever they sit and records the enclosing rig. Anything it cannot
  recognize is left out — the crew degrades to "workers only" rather than inventing a
  hierarchy.
- **Open item:** it is unverified that `gc config show` emits *rig-expanded* named sessions
  with overrides applied. If it emits pre-composition config, suspended entries will not be
  marked; `dedupeByTarget` is the safety net (one card per identity, preferring the one
  with a live session), but the right fix is the gc-side projection.
- **The bead join must agree with the scheduler.** Match `bead.assignee` against the same
  identity set gc's own active-bead matcher uses (id, session name, alias, template). When
  gc projects `active_bead`, prefer it verbatim.
- **`activeProject()` is a security boundary**, exactly as in beads: the renderer-supplied
  root is compared against the registry root and then discarded.
- **`loginShell: true` on every `gc` call is load-bearing** — same `~/.local/bin` PATH gap
  that makes it necessary for `bd`.
- **Actions are typed commands in a real terminal, never background invocations.** That is
  what keeps `reset` and `handoff` visible and interruptible. `gc handoff` requires a
  subject, which is why the command carries one.

## Failure modes seen here

- **A crew card spawning a new terminal on every click** → the identity key was dropped from
  the attach request; `resolveTerminalAttach` is what prevents it.
- **Two cards for the same lead** → a city carrying both a suspended pack lead and its
  replacement, with suspension not visible in the resolved config. See the open item above.
- **An empty crew in a real city** → usually the rig-list read failing, which drops the
  template-qualified and `rig`-field association rules and leaves only `work_dir` matching.
  It is logged, not surfaced, because a partial crew still beats a blank section.
