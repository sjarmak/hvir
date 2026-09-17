# ADR-046: Sessions projects external agent sessions without owning them

> Lifecycle: Active

## Context

hvir's global Sessions destination claims to show every session across every project, but
it can only see sessions hvir launched. A gas city worker is invisible until a user attaches
a terminal to it, and the crew section that does list those workers exists only inside one
workspace's sidebar. The screen that exists to be the one inventory is therefore
systematically incomplete, and the incompleteness is invisible: an empty Sessions list and a
machine with no agents running look identical.

`docs/sessions-ownership-and-feasibility.md` is the ownership gate for this destination. It
established that `SessionsProjectionCoordinator` is a projection over existing owners rather
than a second session authority, terminal runtime, provider observer, or activity
classifier, and it ruled Codex App Server and Claude Code hooks unsupported for provider
topology. That gate is documentation rather than an accepted decision record, and it
evaluated sources hvir would have to introduce into every terminal's launch path. It did not
decide whether a session hvir never launched may appear at all. This record makes that the
accepted boundary, because a second source changes what Sessions means rather than how one
child implements it.

An external session is a durably different kind of fact from a projected hvir terminal.
hvir holds no PTY, no launch profile, no resume artifact, and no attention history for it.
Its lifecycle is owned by another process that can stop, restart, or forget it without
telling hvir. Treating it as an ordinary row without recording that difference would let a
later change quietly assume authority hvir does not have.

## Decision

### The projection admits sessions hvir did not launch

`SessionsProjectionCoordinator` accepts a second class of source: an external agent session
observed through a foreign supervisor, projected read-mostly. The external supervisor remains
the session authority. hvir mints one bounded opaque handle per external session, attributes
the row to a project and workspace, and presents it in the one unified Sessions list.

Every rule in the ownership gate's owner and reuse inventory continues to apply to hvir's own
facts. This record adds a source; it does not relax the gate's prohibition on Sessions owning
project, workspace, retained-session, PTY, connection, telemetry, usage, attention, activity,
runtime, surface, input, resize, or lifecycle-command state.

### One row per session, origin recorded as a fact

A session is one row. When hvir owns a terminal attached to an external session, that row
gains the terminal's capabilities rather than appearing a second time, and the join must be
exact knowledge recorded at launch by the surface that performed the attach. Relationships are
never inferred from titles, paths, current directories, timing, or ambient latest state; that
prohibition is the ownership gate's topology conclusion and it binds this source equally.

Each row carries its origin as structured data, so a consumer distinguishes an external
session from an hvir terminal without reading a title. Projection code branches on origin and
on declared capability, never on a provider name. Facts map across only where the foreign
source actually has them; a fact the source does not provide is `unsupported` rather than
absent, blank, zero, or invented.

### Identity stays opaque

Foreign session and conversation identifiers are internal to the client that resolves them.
They do not enter Sessions IPC, persistence, diagnostics, DOM attributes, logs, or titles. A
projected row is addressed only by its hvir handle. This is the gate's existing identity rule,
applied to a source that arrives with identifiers of its own.

### Membership is sessions, not configured identities

Membership is every external session the source reports, in any state. A configured identity
that was never started is not a session: it has no handle to project, no lifecycle to observe,
and no transcript to read, so it stays a fact of the surface that owns the configuration.

### Authority stops at read, answer, and attach

Sessions may read a projected session, answer an interaction it is explicitly waiting on, send
it a message, and attach an hvir terminal to it. No other verb reaches an external session
through the Sessions IPC surface. Destructive and lifecycle verbs — stop, kill, close, suspend,
wake, reset, handoff, rename, mode changes — stay on the surface where the action is the
user's purpose rather than a side effect of browsing an inventory. Enumerating an inventory and
mutating its members are different authorities, and a list is the wrong place to discover the
second one.

### Demand is per selection, and absence is reported

Sessions opens nothing at list altitude: no stream, channel, process, or timer is created to
render rows. At most one detail-scoped observation exists, for the one selected row, released
on selection change, hide, navigation, or renderer rollover. Hidden Sessions owns none.

This is an addendum to the ownership gate's quiet-hidden rule, which forbids opening a new
transport when Sessions opens. The prohibition holds at list altitude and for host connection
in every case: a projected row never causes hvir to connect a host, and a disconnected or
unreachable source yields a typed unavailable fact instead. One selection-scoped stream on a
host the user already connected is the same bounded, revocable, demand-leased shape the gate
accepts for usage sampling, and it is permitted on that basis.

An unavailable source is a reported state, not an empty list. When no supervisor answers, rows
still come from whatever cheaper enumeration remains, and the detail reports the transcript
unavailable with a reason. A stopped daemon must never render as stopped agents.

## Consequences

Sessions becomes the true inventory of agent work on the user's machines, including the
sessions hvir did not start, which is the case the destination was least able to serve and
most needed for. The split between a global list and a per-workspace crew sidebar closes
without adding a second list one screen over.

hvir now presents state it cannot guarantee. A projected row can be stale the moment its
supervisor dies, so every external fact carries reachability and the UI is obliged to show
staleness rather than assert a last-known value. That obligation is permanent maintenance
cost, and it is the price of the honesty the view needs.

The origin fact and the `unsupported` vocabulary keep the two classes of row from converging
into a lowest-common-denominator card. They also mean each new capability must decide
explicitly whether an external row has it, which is deliberate friction against a later change
assuming hvir owns something it does not.

Because authority is enumerated rather than derived from what the transport permits, a foreign
source that offers more verbs than this record admits cannot widen Sessions by being upgraded.
Revisit this decision if the product accepts lifecycle control over foreign sessions as a
Sessions responsibility, or if a source appears whose sessions cannot be attributed to a
project and workspace at all.

## Rejected alternatives

- A separate list for external sessions. It reproduces the exact split this decision exists to
  close, and it makes "how many agents are running" a question with two answers.
- One row per session plus one row per attached terminal. The user has one worker; two rows
  describe hvir's bookkeeping rather than the thing being watched.
- Inferring the terminal-to-session join from titles, working directories, or launch timing.
  The ownership gate rejected inference for topology, and a wrong join here misattributes a
  transcript and an answer, not just a label.
- Presenting foreign session identifiers as the row identity. It leaks another system's
  namespace into hvir IPC, persistence, and logs, and it makes the identifiers load-bearing for
  anything that later reads them.
- Filling missing facts with zero, blank, or a plausible default so both row classes look
  uniform. A projected zero is indistinguishable from a measured zero.
- Letting Sessions hold an observation per row so selection is instant. Cost scales with
  inventory size rather than with attention, which is the shape the ownership gate's demand
  lease exists to prevent.
- Admitting configured-but-never-started identities as rows. There is nothing to read, answer,
  or attach to, so the row can only ever be a restatement of configuration.
