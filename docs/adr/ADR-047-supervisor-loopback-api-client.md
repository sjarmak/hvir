# ADR-047: Foreign supervisor loopback API as a bounded read-and-answer client

> Lifecycle: Active

## Context

Projecting external agent sessions (ADR-046) needs a transport. The obvious one is the CLI
hvir already runs on these hosts, and it is the wrong one: its session log output is
human-formatted text, and it reads one provider's on-disk conversation directory, so sessions
from other providers produce nothing and nothing it does produce is structured. A view built
on it would be a screen-scraper whose fidelity varies by provider — the shape ADR-003 and
ADR-012 exist to keep out of hvir.

The same supervisor also serves a machine-wide HTTP API on a loopback port, documented by its
own OpenAPI description, with typed transcript reads, server-sent event streams for session
output and city lifecycle, an explicit representation of an interaction a session is blocked
on, and endpoints to answer one or send a message. The transcript response is a discriminated
union whose structured branches are declared provider-neutral, and it reports the provider as
data. Another first-party consumer already depends on exactly these endpoints, so the contract
is observed rather than inferred.

Two constraints make this more than a client-library choice. First, `docs/sessions-ownership-and-feasibility.md`
ruled two candidate provider-observation sources unsupported, and any new source is going to be
measured against that bar; the comparison belongs in an accepted record rather than in a pull
request. Second, the API is unauthenticated — its OpenAPI description declares no security
scheme, and it is protected only by binding to loopback. Anything that can reach the port holds
the supervisor's full verb set, including stopping, killing, suspending, and reconfiguring
sessions. What hvir may do with that reach is a decision, not an implementation detail.

## Decision

### One main-owned client behind `ProjectHost`

A single main-process client owns every call to a foreign supervisor. It reaches the supervisor
through `ProjectHost.connectLoopback`, so a local host and an SSH host share one code path:
`LocalHost` provides an identity route, `SshHost` opens a standard direct TCP forward on its
pooled tunnel role. Per ADR-010, the client is addressed by host; there is no bare, unqualified
supervisor.

Renderer code never speaks to a supervisor. Heavy work — HTTP, stream parsing, schema
validation — stays in main behind a narrow typed port, per ADR-001 and ADR-014.

### A deliberately narrow verb surface

The client exposes only the operations ADR-046 admits: health, city enumeration, session
enumeration, session transcript read, session output stream, host event stream, the pending
interaction a session is blocked on, answering that interaction, and sending a message. It
exposes no method for any other supervisor verb.

The narrowing is by construction, not by convention, precisely because the transport grants
more than this. An unauthenticated loopback API means the bound on hvir's authority is whatever
hvir's own surface offers; a permissive client with a disciplined caller would place that bound
in the wrong module, where every later feature is free to widen it.

### Endpoint resolution is declared, never discovered

Endpoint resolution per host is: the supervisor's documented default port, overridable in that
host's settings, confirmed by one health request the first time a gas-city surface needs it. No
port scanning, no range probing, no candidate sweep, no retry across ports.

ADR-013 forbids hvir probing ports when it activates a web pane. That prohibition is about
discovery: hvir must not go looking for services the user did not tell it about. Connecting to
one documented default, which the user can override and which one health check either confirms
or does not, is not discovery, and this record says so explicitly so the distinction is
reviewable rather than assumed. A health request that fails is a typed unavailable fact; it is
never the first step of a search.

Where the API is keyed by a name and hvir holds a path, the mapping is resolved from the
supervisor's own enumeration. hvir does not derive a foreign key from a local path by
convention.

### Provider-neutral content only, and only on demand

hvir requests the structured transcript representations. The provider-native raw branch is
never requested, so provider-native frames do not enter hvir at all; the boundary is a request
parameter rather than a filter applied after arrival. Optional content the projection does not
present — reasoning traces among it — is not requested either. Control bytes are stripped for
display only and nothing is altered upstream.

Provider identity is data. No method, type, stream handler, or policy in the client branches on
a provider name, consistent with ADR-012 and ADR-036.

### Typed failure, never a throw into a view

Unreachability is a value. Every operation resolves to either a result or a typed unavailable
reason: no supervisor listening, host disconnected, no city at this path, session unknown,
schema rejected, transport lost. The client does not throw into a view, does not retry a
connection in a loop, and does not hold a channel open for a host that is not answering. A
disconnected host yields unavailable and releases its resources; it never triggers a connect.
The reason code is part of the contract because ADR-046 requires the UI to distinguish a
stopped daemon from stopped agents, which is impossible if the failure arrives as a bare
absence.

### Streams are owned, abortable, and cheap enough to be per-demand

Every stream is created by a named owner with an abort signal and is released with that owner.
Aborting closes the underlying channel; a released stream holds no transport capacity. The
SSH tunnel role's pooled capacity is bounded and shared, and the demands this feature creates —
a small fixed number of long-lived streams per host — fit within it with room to spare, which
is what makes the per-selection demand model in ADR-046 affordable rather than merely correct.
Streams support resumption from a server-provided cursor, so a transport loss is reported and
explicitly resumed rather than silently restarted from the head.

A stale result is discarded. Late completions from an aborted request, a superseded demand
generation, or a renderer rollover never reach a consumer.

### Mutations are user-initiated and never automatically retried

The two mutating operations require a header the supervisor checks for presence only, as an
anti-forgery measure. It is not an idempotency key: the server does not deduplicate a repeated
request. A retried answer can therefore answer twice, and a retried message can send twice.
The client does not retry either operation. A failed mutation surfaces its reason to the user,
who decides; an automatic retry would trade a visible failure for an invisible duplicate
external effect.

### Types are generated and pinned

The API is pre-1.0. Types are generated from the supervisor's own description and pinned in the
repository, regenerable by a documented command. Schema drift then arrives as a typecheck
failure against a pinned artifact rather than as a runtime surprise in a view. Responses are
validated at the boundary; a response that does not match is a typed schema-rejected reason,
not a partially-trusted object handed inward.

## Why this clears the bar the evaluated topology sources failed

`docs/sessions-ownership-and-feasibility.md` rejected two provider-observation sources on an
exact, content-free, demand-scoped, revocable, local-and-SSH boundary. The rejections were
specific, and this source differs on each point that decided them.

Both were rejected substantially because adopting them would change how every terminal is
launched: one required a separate long-lived server process with the interactive session
launched against it, making that server part of every launch, transport, authentication, and
recovery path; the other required launch-scoped configuration that could not be revoked from a
live session. This supervisor is already an hvir dependency invoked on these hosts. It is not
introduced into any terminal's launch path, and hvir neither starts, owns, configures, nor
stops it. Nothing about how a terminal launches changes.

Content scoping differs in kind. One rejected source delivered response content and transcript
paths unconditionally, with no documented way to project the event schema before an hvir
handler received it. Here the representation is selected per request: hvir asks for
provider-neutral structured data, and the raw provider-native branch is simply not requested.

Revocation differs in kind. A launch-scoped hook stays active for the life of the session, so
hiding a view could not stop the work it caused. Here every stream is an owned channel through
`ProjectHost`; closing it ends the observation, which is what lets ADR-046 promise that hidden
Sessions owns nothing.

Host parity differs in kind. Both rejected sources needed a remote executable or event sink
plus a cleanup contract that survives transport loss, neither of which `ProjectHost` owned.
Loopback forwarding is one existing `ProjectHost` capability that local and SSH already
implement, so this source has one transport rather than a local design and an unsolved remote
one.

Authority is strictly smaller than what hvir already holds. hvir runs arbitrary commands on
these hosts through `ProjectHost`, including this supervisor's CLI. Reaching the same
supervisor's loopback API is a subset of that reach, so this adds no consent boundary that
arbitrary execution had not already crossed. This is an argument that no *new* gate is
required; it is not an argument that the reach is unbounded, which is why the narrow verb
surface above is the operative limit.

The topology conclusion itself is untouched. The ownership gate's finding that per-subagent
provider topology is unsupported stands, and nothing here infers a relationship from paths,
titles, timing, current directories, ambient latest state, or provider content.

## Consequences

One transport serves local and SSH hosts, structured for every provider the supervisor
supports, which is what makes a projected transcript honest rather than a best-effort scrape.
The pre-1.0 contract becomes a pinned, diffable artifact, so drift is scheduled maintenance
with a compile-time signal instead of a field report.

hvir takes on a dependency on another project's unversioned HTTP surface. Generated types
reduce that to a visible cost rather than removing it, and a supervisor whose description and
whose running build disagree will produce a diff that a human has to read.

The client is narrower than its transport permits, so a future feature that legitimately needs
another verb has to widen it deliberately and argue for that widening. That friction is the
point: the alternative places no bound anywhere.

Refusing to retry mutations means a user sees a failed answer and acts again. That is a worse
success rate and a better failure mode than an answer delivered twice to an agent.

Revisit this decision if the supervisor gains authentication, which would change the authority
argument's shape; if it reaches a stable versioned contract, which would change the pinning
cost; or if it offers per-request idempotency, which would make bounded retry safe.

## Rejected alternatives

- Driving the CLI and parsing its session log output. Human-formatted text, single-provider
  coverage through one on-disk conversation directory, and a parser that breaks on cosmetic
  output changes. Provider-neutral structure is the whole reason the API wins.
- Probing a port range, or sweeping candidates when the default does not answer. Discovery is
  what ADR-013 prohibits, and a sweep turns one honest unavailable into a guess about which
  service answered.
- A permissive client mirroring the whole API, with callers restrained by convention. It puts
  the authority bound in the wrong module and makes every later caller a place where it can be
  widened silently.
- Requesting the raw provider-native transcript branch and filtering afterward. Content hvir
  has already received is content hvir is responsible for; selecting the representation at the
  request is the only version of this that is actually a boundary.
- Branching on provider name to normalize transcripts. The API already reports provider
  identity as data, and the branch would recreate inside hvir exactly what the provider
  registry seam exists to contain.
- Hand-written types tracking the API by inspection. Drift becomes a runtime surprise in a
  view rather than a typecheck failure, on a pre-1.0 contract where drift is expected.
- Throwing on unreachability. A view cannot distinguish a dead daemon from dead agents from an
  exception, which is the exact confusion ADR-046 requires the UI to avoid.
- Retrying a failed answer or message automatically. The server checks its anti-forgery header
  for presence only and deduplicates nothing, so a retry risks a duplicate external effect on
  someone else's agent.
- One persistent connection per projected session, or a connection opened to render the list.
  Cost scales with inventory rather than attention, and it contradicts the demand lease
  ADR-046 depends on.
- A hvir-owned daemon, or a remote helper on SSH hosts, to normalize supervisor access. ADR-010
  rejects a remote server, ADR-006 rejects a session daemon, and the existing loopback
  forwarding makes both unnecessary.
