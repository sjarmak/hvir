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

The renderer uses existing typed human-work classification for Beads and existing
session attention. Requested PR reviews, failing authored checks, and current authored
feedback are distinct reasons. Prose is not classified and no semantic priority score
is introduced. GitHub identities include the repository and PR number; project data
retains its host-qualified source. Refresh is explicit for CLI-backed snapshots.

Session selection routes to the existing Sessions owner with exact identity. Bead
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
