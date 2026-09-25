# ADR-064: Architecture review as a live, zoomable canvas

> Lifecycle: Active
> Supersedes: [ADR-063](ADR-063-architecture-review-history-and-agent-worktrees.md) | partial | The map opening on subsystem relationships in a fixed grid; it now opens on systems on a laid-out canvas that drills to subsystems and modules.

## Context

The architecture review draws its map as a fixed two-column grid of subsystems with no pan or
zoom, and shows change only after the person presses Scan snapshot. The person reviewing
wants two things it does not give: to see what an agent changed while the agent works, and to
start from the big picture of a project before its subsystems.

devdotfast/whiteboard (MIT) answers a similar need. The agent writes a review canvas for one
change: a C4-style map of systems, containers and components laid out by elkjs on a React
Flow canvas, a design diagram, and an account of what changed and why. Its diagrams are
authored by the agent and checked against the repository afterwards. hvir's map is derived
from the code by static analysis and is true by construction, but carries no intent.

## Decision

**Three levels.** The review knows a project as Systems, Subsystems and Modules (CONTEXT.md).
A System groups the subsystems that run or ship as one part. Systems are inferred from the
project's own layout (package workspaces, Electron process entry points, Cargo and Go
workspaces) and may be named in `.hvir/architecture.json`, as subsystems already may. Every
box expands in place to the level beneath it; the map opens on Systems.

**A laid-out canvas.** The map is a pan and zoom canvas built on `@xyflow/react`, laid out
automatically by `elkjs`. Layout runs off the render thread and is computed from the union of
both ends, as today, so a box keeps its place across views and across successive snapshots.
Positions are not hand-placed or saved. The canvas replaces the grid; the commit strip, the
Overlay, Before and After views and the evidence panel stay.

**Change is drawn in place.** Added boxes and relationships are green, changed ones amber, and
removed ones remain as dashed ghosts where they stood. In a live review they animate in and
out.

**Live review is a series of snapshots.** When the Current end is the working tree, the
review may follow it: after writes settle for about two seconds it takes a new snapshot, and
the person may pause it. A snapshot still never changes. The snapshots of one live review form
a timeline the person can scrub, held for the application session only; commits remain the
durable history.

**The agent explains; the scan observes.** An "Explain this change" action hands one snapshot
to an agent through the existing handoff. The agent returns an Explanation: what changed and
why, one sequence diagram, and the systems, subsystems and modules it says it touched. hvir
stores the Explanation against that snapshot, shows it apart from what the scan observed, and
flags every name it gives that the snapshot lacks. The workbench never generates or judges an
Explanation itself.

**Ideas, not code.** hvir takes whiteboard's hierarchy, canvas and layout libraries and its
agent-written account of intent. It copies none of its source, since whiteboard's map is
bound to its own agent-authored document format and to a vendored editor.

## Consequences

The review answers "what did the agent just do to the structure" while the agent is still
working, and opens at a scale a person can take in at once. Two new renderer dependencies
arrive (`@xyflow/react`, `elkjs`) and fall under the dependency policy of ADR-040. System
inference is a new scanner concern with its own failure mode, a wrong grouping, which the
tracked override answers. Live review multiplies scans; the blob-keyed parse cache of ADR-063
keeps a settled rescan to the files that changed. An Explanation costs an agent session each
time and can be wrong; the unknown-name check catches invented structure but not a wrong
account of intent, which is why it is always shown as a claim.

Revisit if a live review's scan cost on a large project over SSH makes the settle interval
unusable, or if people consistently rearrange the map by hand in other tools and ask to keep
positions.

## Rejected alternatives

**Agent-authored maps, as whiteboard does.** Richer and intent-bearing, but a map that can be
wrong undermines the one thing the review is for while an agent works, and every map would
cost tokens.

**Hand-placed, saved positions.** The whiteboard feel comes from automatic, stable layout;
saved positions add storage and a stale-layout problem for a benefit nobody has asked for yet.

**C4's own words (System, Container, Component).** Container collides with Docker and
development containers that hvir users meet daily, and Subsystem and Module are already the
review's language.

**Live review as one updating snapshot.** It would break the rule that a snapshot is fixed to
the bytes read, on which pinned evidence depends.

**Persisting live snapshots to disk.** Commits already carry durable history; saving every
settled tree would store mostly noise.

**Explanations generated for every snapshot.** Spends an agent session per scan whether or
not anyone reads it.

**Keeping the grid beside the canvas.** Two maps of the same data to maintain, and nothing in
the grid the canvas does not show.
