# ADR-975: Bounded background workspace sampling during refresh bursts

> Lifecycle: Active
> Supersedes: [ADR-027](ADR-027-demand-driven-workspace-activity.md) | partial | A full demand-driven refresh sampling status for every present worktree of the project.

## Context

ADR-027 made open-workspace activity demand-driven: the active workspace's content watch and its
shallow Git-metadata watch, explicit refreshes, and Git mutations request a full project refresh,
and a full refresh samples the bounded porcelain status for every present worktree. The
Git-metadata watch observes the repository's shared `.git` directory, which every linked worktree
writes through when it fetches, commits, or moves a ref.

A project driven by agents breaks that assumption. One registered Omni repository carried twenty
linked worktrees, each worked by an autonomous session that fetched and committed continuously.
Every ref write landed in the shared `.git` directory, the watch requested a full refresh, and
each refresh ran `git status --porcelain=v2 -z --untracked-files=all` across all twenty
worktrees. The 350 ms debounce and in-flight deduplication only bounded concurrency, not
frequency: as soon as one refresh finished the next began. The Mac sat at a load of 25 to 40 and
unrelated test suites timed out.

The person is looking at one workspace. The others only need their changed-file badge to stay
roughly current, which the five-second passive cadence already treats as acceptable for closed
workspaces under ADR-023 and ADR-027.

## Decision

A full refresh still discovers worktrees and still samples the active workspace of the project on
every request. A workspace that is not active is sampled when it has never been sampled by this
coordinator, when discovery reports that its HEAD or branch moved since the previous project
state, and otherwise at most once per thirty seconds. The coordinator keeps the last sample time
per present workspace as ephemeral in-memory state, discards it when the workspace disappears or
the project is invalidated, and persists nothing. Passive polling of closed workspaces, the dirty
suspension, generation checks, and the exact status grammar granted to the Git worker broker are
unchanged.

The interval is a single exported constant so tests and future tuning name one number.

## Consequences

A burst of shared `.git` activity costs one status for the active workspace per debounced event
plus at most one status per background worktree every thirty seconds, instead of one status per
worktree per event. A background worktree whose agent committed is still sampled promptly,
because its HEAD moved. A background worktree whose working tree changed without a commit shows
its new changed-file count within thirty seconds rather than within the debounce window.

Explicit refreshes after Git mutations in the active workspace behave as before. A newly
discovered worktree is sampled on its first refresh.

## Rejected alternatives

- Ignore Git-metadata events that originate from other worktrees. The shared `.git` directory
  does not say which worktree wrote a ref, and the active workspace legitimately needs those
  events.
- Watch each worktree's own metadata directory. ADR-008 and ADR-023 forbid per-worktree watchers.
- Lengthen the debounce. Longer debounce delays the active workspace the person is watching and
  still runs every worktree once the debounce elapses.
- Sample only the active workspace on a full refresh. Background badges would then update only
  on HEAD movement, leaving uncommitted work in other worktrees invisible indefinitely.
