# ADR-977: Focus-gated workspace polling

> Lifecycle: Active
> Supersedes: [ADR-027](ADR-027-demand-driven-workspace-activity.md) | partial | Periodic discovery and closed-workspace sampling running while no hvir window is focused.

## Context

The workspace coordinator's periodic refresh ran every five seconds while any hvir window
existed, focused or not. Under ADR-027 a periodic refresh does not sample open workspaces. For
each connected repository project it runs worktree discovery, reconciles the registry with it,
removes missing workspaces, and samples bounded porcelain status for every closed present
workspace whose latest comparable status is clean or missing. A dirty closed workspace is
suspended from passive sampling until discovery sees its HEAD or branch move.

That last sample is the cost. A clean closed worktree is sampled on every poll, and on a
worktree with about twenty thousand tracked files one
`git status --porcelain=v2 -z --untracked-files=all` took about a second and 1.1 CPU-seconds,
because the broker passes `-c core.fsmonitor=false` and Git reads every tracked file's stat data.
Two running app copies kept roughly half a core busy, including while both were in the
background.

## Decision

Periodic refresh runs every thirty seconds and only while some hvir window is focused. While no
window is focused the coordinator runs no periodic refresh and holds no poll timer. When a window
gains focus after none was focused, the coordinator runs one periodic refresh at once and resumes
the thirty-second cadence. What a periodic refresh does is unchanged: discovery, reconciliation,
missing-workspace removal, and the passive closed-workspace sample described above.

Focus is read from the main-owned attention aggregate that already decides away-state (ADR-949),
through a narrow port, so the coordinator does not depend on Electron. A window seeds its owner's
focus at creation and again when a renderer reload or crash replaces its owner generation, so
reloading the only focused window does not leave hvir reported as away.

Demand-driven refreshes are unchanged: project opening, explicit refresh, the active-workspace
and Git-metadata watches, and Git mutations still refresh at once whatever the focus.

The broker keeps `-c core.fsmonitor=false`. Git's built-in monitor (`core.fsmonitor=true`) would
make each sample cheap, but Git 2.35 and older reads `true` as a hook path and runs the `true`
program, whose empty successful output can hide tracked modifications, and the daemon is not
available on every platform hvir connects to.

## Consequences

An unfocused hvir runs no periodic Git work, and a focused one runs a sixth as much. A clean
closed workspace that changes while hvir is unfocused is sampled again when a window next gains
focus, and otherwise on a thirty-second interval instead of five. ADR-027's eligibility and
dirty-suspension rules are unchanged, so a closed workspace already suspended after a dirty
result is still not sampled until its HEAD or branch moves. Worktree additions and removals made outside
hvir appear on the same schedule. Switching directly between two hvir windows can briefly report
no focus and trigger one extra refresh.

## Rejected alternatives

- Select Git's built-in file monitor. Older Git runs `true` as a hook and can report a modified
  worktree as clean.
- Slow the cadence without focus gating. A background hvir would still sample every clean closed
  worktree.
- Pause when the window is occluded or minimized without losing focus. Focus is the one signal
  main already owns and is what a person returning to hvir produces.
