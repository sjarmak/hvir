# ADR-049: The Companion is an away-time observer served by the running app

> Lifecycle: Partially superseded
> Supersedes: [ADR-009](ADR-009-hierarchical-attention.md) | partial | The OS badge as the only attention surface while all hvir windows are unfocused.
> Supersedes: [ADR-010](ADR-010-project-host-remote-boundary.md) | partial | The prohibition on any hvir-owned network listener, for one loopback-bound Companion listener.
> Superseded by: [ADR-050](ADR-050-companion-live-terminal-mirror.md) | partial | The exclusion of a terminal screen and terminal input from the Companion, for live hvir-owned terminals under a mirror lease.

## Context

hvir exists for the person who hands work to agents and stays in the loop. ADR-009 and ADR-019
made "a session needs me" a precise, provider-independent set: a terminal that went Ready or
rang a bell after a submission. ADR-048 widened that set to an external session whose authority
declares a pending interaction, so a blocked gas city worker raises the same badge as a waiting
terminal. Every one of those signals stops at the desk. The OS badge is the only surface admitted
while all hvir windows are unfocused, and ADR-009 forbids sound, toast, or any urgency fallback.
A user who walks away learns that an agent has been blocked for an hour when they return.

The facts a remote surface needs already exist and already have owners. The Sessions
destination projects every session, hvir-launched or external, as one row with opaque handles;
the renderer owns terminal attention and publishes an aggregate toward main for the badge; main
owns external attention, the observation port, and the only client that may answer or message an
external session (ADR-046, ADR-047). No network listener exists anywhere in hvir. ADR-010 rejects
an installed remote server or daemon; ADR-013 rejects persisted dashboards, server registries,
and port discovery; ADR-014 rejects a new process boundary. The sessions ownership gate forbids a
second session authority and requires Sessions to own nothing while hidden.

The user's phone is a node on a private tailnet alongside the desktop that runs hvir, and that
desktop already publishes local ports to the tailnet through the operator's own tooling.

## Decision

### The Companion is a second aggregate surface, not a second authority

The Companion is a phone-sized web client of the running hvir application. It presents the same
Sessions inventory the desktop presents, sorted for triage: sessions with actionable attention
first, then every other session grouped by project and workspace. Its rows are the existing
projection rows addressed by the existing opaque handles. It carries exactly the verbs ADR-046
admits for an external session: read, answer the pending interaction the session is waiting on,
and send a message. No destructive or lifecycle verb, no terminal input, and no terminal screen
crosses the Companion. An hvir-launched terminal session appears with its row facts only; its
live surface remains a renderer-owned lease that the projection may not copy.

The Companion is an observer. Viewing a session in it never clears attention. A terminal's
attention still clears only on terminal focus (ADR-009); a pending interaction still clears only
on resolution (ADR-048), which the Companion may perform by answering.

### hvir listens on loopback; the operator publishes it

The Companion server lives in the main process and dies with the application. It is off by
default, enabled in Settings, and binds one configurable loopback port. hvir never binds a
non-loopback interface, never discovers a tailnet or LAN address, never manages certificates, and
never installs anything that outlives the app. Reaching the port from another device is the
operator's act through the operator's tooling, exactly as ADR-013 leaves activating a loopback
link to the user. This is the one narrowing of ADR-010's "no remote server": a bounded listener
inside the running app on the loopback interface, not a service.

Inside that wall a pairing code is required. Settings issues a one-time code, the phone exchanges
it once for a long-lived credential bound to this Companion, and Settings can revoke it. Network
reachability is never treated as authentication, because any local process can reach loopback.

### One actionable set feeds the badge, the Companion, and Push

The renderer's publication toward main widens from a count to a per-session actionable set: an
opaque handle, the kind of signal, and its freshness with reason. Main joins that set with the
main-owned observation port and external attention. The desktop badge, the Companion, and Push
all read this one set, so the three surfaces share ADR-019's single definition of actionable and
cannot disagree about it. Classification does not move: Ready and bell remain renderer terminal
policy; a pending interaction remains its authority's declaration.

The Companion holds a projection demand lease only while a paired phone has the page open, and
releases it on close, consistent with the ownership gate's quiet-hidden rule. Push needs no
lease: the actionable set is always current while hvir runs.

### Push fires while Away, once per appearance, to a declared sink

Away is the existing predicate: every hvir window unfocused. It admits the OS badge today and it
alone admits Push. A session entering the actionable set while Away produces one Push; leaving it
produces none, because a delivered notification cannot be retracted and the Companion shows the
current truth. A terminal that goes Ready again after a new submission produces a new Push.

A Push carries a pointer and one line: the project, the session title, the kind of signal, and
the first line of a pending prompt, truncated. It carries no options, no identifiers, no
transcript, and no credential. hvir posts it to a declared notification sink configured in
Settings, with no discovery and no retry loop, in the posture ADR-047 sets for the supervisor
client. Which sink, and where it runs, is operator infrastructure outside this repository.

### Staleness travels

Per ADR-048, a surface that cannot express staleness may not display actionable attention. Every
Companion row and every Push derive from facts that carry freshness and reason. A fact marked
stale because an observing stream was lost is shown as unconfirmed with its reason in the
Companion and is never pushed as an alarm.

### One Companion per running hvir

Each running hvir instance serves its own Companion and pairs on its own. There is no
cross-desktop aggregation and no desktop-to-desktop transport.

## Consequences

A blocked agent reaches its user wherever the user is, through the same actionable definition
the desk already trusts, and the user can unblock it from the phone. The desktop model is
untouched: no new clearing rule, no new classification, no Working on a phone.

hvir gains its first inbound network listener. Its authority is bounded by construction to the
verbs Sessions already admits, its reach is bounded to loopback, and its existence is bounded to
the running application and an explicit setting. The operator owns publication, certificates,
and the notification sink; the repository owns none of that infrastructure.

The renderer-to-main attention publication becomes a richer contract, and Away-time correctness
now depends on a hidden renderer still classifying Ready on time. That must be verified under
background throttling rather than assumed.

ADR-009's rejected alternatives remain rejected on the desktop: no sound, toast, bounce, flash,
or urgency hint is added there. Push is admitted only for the away-time channel, only while Away,
and only for the actionable set.

Revisit this record if hvir ever needs to be reachable while not running, to aggregate several
desktops, or to carry terminal input from a phone. Each of those is a different decision, not an
extension of this one.

## Rejected alternatives

- A separate always-on daemon or an installed remote service: a second session authority, which
  the ownership gate and ADR-010 both forbid, and one that cannot see hvir's own terminals.
- hvir binding a tailnet or LAN address and serving its own TLS: address discovery, certificate
  lifecycle, and a non-loopback listener, none of which the operator's existing tooling requires.
- Moving Ready and bell classification into main so main owns all attention: overturns the
  ownership gate for no gain, since a richer publication of the renderer's existing result
  suffices.
- Serving the Companion from the renderer through an IPC relay: network I/O in the render
  process, against ADR-001 and ADR-014.
- Raw terminal input or a live screen mirror on the phone: a fat-finger hazard on an agent's
  terminal with no structured pending question to answer, and a copy of a surface the projection
  may not own.
- Answering from the notification itself: embeds a credential in every notification and answers
  blind to the revision check ADR-048 requires at answer time.
- Pushing on resolution or as a digest: retraction is impossible and batching delays the one
  signal that matters; the Companion carries current truth instead.
- Trusting tailnet identity headers instead of pairing: reachability is not authentication when
  every local process can reach the same port.
- Extending an external dashboard to show hvir sessions: only hvir knows about hvir-launched
  terminals, so hvir would have to publish them anyway.
