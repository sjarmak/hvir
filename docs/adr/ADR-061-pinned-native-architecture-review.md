# ADR-061: Pinned native architecture review

> Lifecycle: Partially superseded
> Superseded by: [ADR-063](ADR-063-architecture-review-history-and-agent-worktrees.md) | partial | The fixed comparison modes, the full recapture on revalidation, and the read-only single-file handoff consumed once per snapshot; pinned evidence, worker isolation, and launch authority remain.

## Context

Architecture review needs to connect observed dependency changes to exact source evidence.
Reopening a normal Git diff can resolve a different revision or newer live content than the
map used. A standalone review server would duplicate hvir's host, viewer, terminal and
workspace authority on the maintained custom-feature branch.

## Decision

A dedicated main-owned architecture-review capability captures bounded source pairs through
`ProjectHost` and the Git command context. Comparison modes retain existing meanings:
index to live tree, HEAD to live tree, and branch point to HEAD. Explicit commit to live tree
is a separate mode. Resolved commit identities, host-qualified workspace, captured text and
configuration, and disclosed scan scope determine one fingerprint. Index blobs are read by
object identity. A second live read detects edits during capture; this is a consistency check,
not a claim of filesystem transactions.

AST extraction and subsystem projection run in a request-owned utility process with no host
or process-launch authority. Workspace/renderer leases own captures; cancellation terminates
the worker and rejects late completions. Capture and graph limits fail or disclose omissions;
unsupported or partial analysis cannot be presented as a clean review.

The renderer uses a native typed review tab and existing CodeMirror diff presentation. Evidence
comes from captured text, never from re-resolving a normal diff request. Revalidation marks
changed snapshots stale and calls for refresh while identifying any displayed historical pair.
Directory grouping and observed import facts remain explicit; responsibility shifts and other
semantic judgments belong to an agent and require source citations.

A review handoff carries snapshot provenance and selected evidence to a separate visible
provider-owned terminal session. Harness providers, launch profiles and the PTY supervisor
retain launch and delivery authority. After a preview and explicit launch, providers receive
the reviewed body as their initial prompt argument. This capability is limited to a new session
with an unmodified provider executable and arguments; resume and existing-terminal delivery
are excluded. Main revalidates the fingerprint and preview digest, then consumes the snapshot
launch once. Failed or uncertain launches require a refreshed review before another attempt.
User acceptance is required to pass a finding to the
existing Beads creation workflow. Architecture evidence does not become a user-authored
source-document review record.

## Consequences

The map and viewer share reproducible evidence without an HTTP listener, browser persistence,
custom diff engine or competing agent lifecycle. Bounded snapshots consume memory until their
workspace lease ends. Live-tree capture can require retry during edits. Initial scans cover
JavaScript and TypeScript; unresolved configuration and imports are visible limitations.

## Rejected alternatives

- Copying the prototype server and direct CLI launcher duplicates established authorities.
- Opening a fresh Git diff silently permits graph/source disagreement.
- Parsing or graph analysis on the render thread violates paint responsiveness.
- Inferring semantic architecture from directory names presents interpretation as observation.
