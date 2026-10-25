# ADR-978: Focus-gated SSH refresh pulses

> Lifecycle: Active
> Supersedes: [ADR-977](ADR-977-focus-gated-workspace-polling.md) | partial | Synthetic SSH refresh pulses on the active-workspace and Git-metadata watches refreshing workspace Git state while no hvir window is focused.

## Context

An SSH watch emits a synthetic `refresh` change for every watched path every two seconds while
its host is connected, whatever the watch tier, so a remote edit the shallow watch cannot see
still reaches the file tree and the workspace's Git state. The active workspace's content and
Git-metadata watches forward each pulse to the workspace coordinator as a Git refresh. Every
pulse-driven refresh lists the project's worktrees, samples porcelain status for the active
workspace, and samples any other present workspace whose last sample is thirty seconds old
(ADR-975).

ADR-977 stopped the periodic poll while no hvir window is focused but kept watch-driven
refreshes running at once whatever the focus. The pulse is a timer, not a change, so on an
SSH project an unfocused hvir still ran a worktree listing every two seconds, a status of the
active workspace on every pulse, and a status of every other present worktree every thirty
seconds. With two dozen Omni worktrees that was about one porcelain status per second all
night, each costing about a CPU-second on the remote machine.

## Decision

The project watch labels each Git refresh it requests as a real change or a pulse, from the
event's `synthetic` marker. The workspace coordinator drops a pulse refresh while no hvir window
is focused, reading focus from the same attention-aggregate port its periodic poll uses
(`AttentionBadge.windowFocus`, ADR-977). A focused hvir handles pulses as before, so the active workspace stays
fresh and other workspaces keep ADR-975's thirty-second bound.

Real watch events are unchanged: a change under the active workspace or its Git directory, Git
discovery after `git init`, project opening, explicit refresh, and Git mutations still refresh
at once whatever the focus. The initial and reconnect snapshot an SSH watch emits is also
marked synthetic, so it is gated the same way; changes made while disconnected reach Git state
on the first pulse after a window gains focus. The SSH watch keeps pulsing; the file tree still
receives the synthetic events, which read directories over SFTP and run no Git.

## Consequences

An unfocused hvir runs no Git work for SSH refresh pulses. A remote edit the shallow watch
cannot see, made while hvir is unfocused, reaches the active workspace's Git state within one
pulse of a window gaining focus. Edits that touch the index, HEAD, or refs still arrive through
the Git-metadata watch as real events and refresh at once.

## Rejected alternatives

- Stop the pulse in the SSH watch service while unfocused. That would couple the project host to
  window focus and also freeze the file tree, which costs no Git work.
- Slow the pulse. A background hvir would still run Git work on a timer for the active
  workspace and every worktree's thirty-second sample.
