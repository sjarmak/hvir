# hvir

hvir is a view-first workbench for agentic development: it watches the harnesses (Claude Code,
Codex, gas city workers) you hand work to, shows the code and Git they touch, and lets you
respond when one of them needs you. This glossary holds the terms the product and its ADRs use.

## Language

### Sessions

**Session**:
One running or retained agent conversation, whoever started it. A session is one row in
Sessions regardless of how many surfaces observe it.
_Avoid_: terminal (a terminal is one way to attach to a session), agent, worker, thread

**Terminal session**:
A session hvir launched itself through a PTY, on a local or SSH host. hvir is its authority.
_Avoid_: hvir session, own session, local session

**External session**:
A session observed through a foreign supervisor (today: gas city). The supervisor is its
authority; hvir projects it and may read it, answer it, message it, or attach a terminal to it.
_Avoid_: projected session (that is the presentation, not the thing), gas city session,
crew member (a configured identity, not necessarily a session), worker

**Pending interaction**:
A question an external session's authority declares it is blocked on, with the options the
session will accept. It exists until resolved: answered from anywhere, or withdrawn because the
session moved on.
_Avoid_: prompt, blocker, question, approval

### Attention

**Actionable attention**:
The one shared definition of "a session needs me": a terminal session that is Ready or rang a
bell after my submission, or an external session with a pending interaction. This is the set
every parent count, the OS badge, and any remote surface may show.
_Avoid_: notification, alert, unread

**Ready**:
A terminal session that went quiet after a submission boundary: the agent stopped and is
waiting. Clears on terminal focus.
_Avoid_: idle, done, finished

**Working**:
A terminal session still producing output after a submission. Low salience, row-only, never
counted anywhere.
_Avoid_: busy, running, active

**Away**:
The state in which every hvir window is unfocused. It is the predicate that admits the OS
badge and any remote notification; while not Away, the desktop is the only attention surface.
_Avoid_: unfocused, idle, AFK, background

### Remote

**Companion**:
The phone-sized web client, served by the running hvir app over the tailnet, that shows the
Sessions inventory and carries exactly the external-session verbs Sessions admits: read,
answer a pending interaction, send a message. It is an observer: viewing in the Companion
never clears attention.
_Avoid_: mobile app, remote, dashboard, phone view, mirror

**Push**:
One delivery to the Companion's owner, while Away, that a session entered the actionable set:
the project, the session title, the kind of signal, and at most one line of a pending prompt.
It points at a session; it is not a copy of the session and never carries options, identifiers,
or credentials.
_Avoid_: toast, alert, notification (ambiguous with the desktop badge)

### Architecture

**Architecture review**:
The workbench surface that shows how a project's structure changed between two points and
lets the person judge that change or hand it to an agent. Its job is review; browsing history
is one way of choosing what to review.
_Avoid_: architecture diff viewer, diff viewer, dependency graph, map (the map is one view
inside it)

**Snapshot**:
One comparison of a project's structure between a baseline and a current end, fixed to the
exact bytes read at that moment. A snapshot never changes; a new comparison is a new snapshot.
_Avoid_: scan (the act that produces one), capture, report, analysis

**Baseline** / **Current**:
The two ends of a snapshot. Either may be a commit; only the current end may be the live
working tree. Two commits can never go stale; a snapshot whose current end is the working tree
is stale once that tree differs from what was read.
_Avoid_: before/after (presentation words for the two sides), source/target, left/right

**System**:
The top level of a project's structure: a named group of subsystems that runs or ships as one
part, such as the desktop app, the Companion page, or a background worker. Inferred from the
project's own layout unless the person names them.
_Avoid_: container, application, service, tier, layer

**Subsystem**:
The unit the review compares structure at: a named group of modules whose imports of one
another are counted as one relationship. Modules and their individual imports are the
evidence beneath it.
_Avoid_: group, directory, package, area, layer

**Module**:
One source file as the review sees it: the smallest box, whose imports are the evidence for
the relationships above it.
_Avoid_: component, file (the bytes, not the unit), unit

**Live review**:
An architecture review that follows the working tree, taking a new snapshot each time the
tree settles after writes, so the person watches structure change while an agent works.
_Avoid_: watch mode, auto-refresh, live snapshot (a snapshot never changes)

**Explanation**:
An agent's written account of one snapshot: what changed and why, in its own words and
diagrams. It is the agent's claim, shown apart from what the scan observed, and any system,
subsystem or module it names that the snapshot lacks is flagged.
_Avoid_: summary, review (the review is the person's), description, narrative
