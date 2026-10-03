# ADR-971: Selected hosted pull-request feedback handoff

> Lifecycle: Active

## Context

The GitHub rail currently exposes pull-request summaries and counts but not the
specific review threads that explain the work. A person evaluating an agent's
change needs bounded access to selected hosted feedback, while GitHub remains an
external authority and feedback may contain untrusted instructions.

## Decision

The active-root GitHub service provides a foreground, on-demand detail read for a
selected pull request. The request includes the exact resolved repository, pull
request number, and known head identity. The service revalidates the active
host-qualified root after the external read and fails closed when identity is
unknown or has drifted. Thread and reply pages are bounded and disclose
incompleteness or truncation.

The renderer owns selection and creates an immutable preview labelled as
untrusted hosted feedback. Preview and clipboard copy operate on the same bytes
and are the only handoff actions. hvir does not post, resolve, acknowledge,
merge, push, or send feedback into a terminal. This is separate from the
source-document review handoff in ADR-032.

## Consequences

Review context is available without adding a GitHub mutation authority or a
second feedback store. Details are an as-of view and require an explicit
selection; closed views do not poll. Missing identity, stale heads, refused
reads, and bounded pages remain visible rather than becoming guessed freshness.

## Rejected alternatives

- Automatically acknowledge or resolve hosted comments: this would mutate an
  external review authority without an explicit user action.
- Send selected feedback directly to an agent terminal: this would cross the
  PTY and provider authority boundary and needs a separate contract.
- Treat hosted feedback as trusted instructions: review content is untrusted
  external data and must remain inert in the preview.
