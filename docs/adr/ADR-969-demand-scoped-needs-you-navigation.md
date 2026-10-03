# ADR-969: Demand-scoped Needs you navigation

> Lifecycle: Active

## Context

Sessions, Beads, and GitHub each expose information that needs a person's attention.
Switching among project rails obscures that work. Their source owners already define
attention, human decisions, review requests, checks, and feedback. A combined view must
not become a second orchestrator or silently expand the active-workspace rail authority.

## Decision

Needs you is a read-only application destination. It composes the existing Sessions
projection with bounded Beads and GitHub reads for registered, present, open workspaces
on already-connected hosts. Main selects trusted host-qualified roots; the renderer
cannot supply arbitrary roots. Existing rail IPC retains its active-root restrictions.

The cross-project read owner holds renderer-qualified demand only while the destination
is foregrounded. Acquisition and explicit Refresh perform finite reads with bounded
concurrency, subprocess deadlines, and output limits. Release, renderer replacement,
host disconnection, and workspace removal revoke results from older demand. There is
no periodic scan while the view is closed, no automatic host connection, and no new
persisted attention state. Sources report availability and read time independently;
partial failures and bounded GitHub search coverage remain visible.

Main reads each Beads store once per read, however many worktrees resolve to it, and
reports its items under the workspace that holds the store. On a host with a
registered Gas City workspace, main also reads the store of the city's `decisions`
rig, located through `gc rig list`, even when it is not an open workspace. That store
uses the city's open-asks rule: an open bead labelled `needs/stephanie` with no
`gc.answered` stamp. Its rows are listed without navigation, since no workspace owns
them. Main applies the human-work rule before the per-source item limit, so the limit
bounds items needing a person rather than the head of the issue list. The view lists
only sources that failed or were truncated; a workspace with no Beads project or no
GitHub remote is not a problem.

The shared typed human-work classification serves both main and the renderer, alongside existing
session attention. Requested PR reviews, failing authored checks, and current authored
feedback are distinct reasons. Prose is not classified and no semantic priority score
is introduced. GitHub identities include the repository and PR number; project data
retains its host-qualified source. Refresh is explicit for CLI-backed snapshots.

Session selection opens the exact terminal in its workspace through the existing
Sessions open request, and falls back to the Sessions destination with the exact row
selected when that terminal is unavailable or the request fails. Bead
selection routes through the existing workspace and Beads panel owners, and the
destination confirms the requested bead against its own read before revealing it.
PR selection retains the explicit GitHub link. No action starts an agent, creates a
checkout, answers a decision, resolves feedback, or changes attention badges or
Companion behavior.

Session cards additionally expose available or stale launch-profile identity for
hvir-owned sessions. This is a launch identity, not proof of a running process's
effective environment or an Omni deployment target. External sessions do not inherit
the viewing terminal's profile.

## Consequences

One destination reduces navigation while retaining source authority. Results are an
as-of view, not a complete continuously monitored work queue. Disconnected and closed
workspaces are excluded and explicitly disclosed. CLI/API failures cannot prove that
no work remains. Bounded reads and released observation keep the feature from turning
into a global background poller.

## Rejected alternatives

- Relax active-root validation on existing rail channels: unrelated callers would gain
  cross-project authority.
- Poll every project continuously: the view would create demand even when unused.
- Infer urgency from titles or comments: source facts do not authorize semantic policy.
- Add another task or notification store: existing owners already own these states.
- Treat launch profile names as live Omni target provenance: stored launch identity
  cannot establish effective runtime configuration.
