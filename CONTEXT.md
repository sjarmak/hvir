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
