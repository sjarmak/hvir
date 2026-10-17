# ADR-976: Pull request waits ordered by holder and business time

> Lifecycle: Active

## Context

The GitHub rail lists open pull requests in three sections ordered by recency, and Needs
you reduces a pull request to three flat reasons: review requested, CI failing, open
feedback. Neither says who the pull request is waiting on or for how long. A review
requested on Friday evening reads as three days old on Monday morning, and the newest
pull request sits above the one a teammate has been blocked on all week.

Flow, an Omni-internal pull request queue, answers one question: what needs me on GitHub,
oldest ask first. Its model is a pure derivation over GitHub facts: who holds the ball on a
pull request, since when, with ages counted in business time. Its runtime is a polling
server with a local store and one-key writes to GitHub. hvir reads GitHub on demand under
ADR-969 and never mutates a pull request under ADR-971, so the model fits and the runtime
does not.

## Decision

The GitHub capability's pull request query carries, per pull request, the pending review
requests with their requester type, the latest opinionated review per reviewer, the review
requested, ready for review and assigned events, the creation time, and the change size.
Bot reviewers are dropped by GraphQL type, never by login substring. The parser exposes
these as typed fields on the shared pull summary; absence is explicit, never guessed.

Two shared pure modules derive the view. Business time counts elapsed milliseconds while
skipping Saturdays and Sundays in local time; holidays are not skipped. Holder derivation
follows one precedence: draft, then pending reviewers (each holding since the later of
their latest request and the last ready for review), then standing changes requested held
by the author, then approval held by the author, then nobody. An inbound ask is a direct
request, a request through a team, or an assignment. The same modules serve main and the
renderer; neither duplicates the rule.

The GitHub rail keeps This branch first and then shows one Needs you list ordered oldest
ask first: inbound asks and the viewer's own pull requests whose ball came back (CI
failing, ready to merge, changes requested, no reviewer yet). The viewer's pull requests
held by others form a Waiting list ordered the same way; drafts list newest first. Every
row names its reason and its business-time age, neutral under one business day, amber
from one, red from three. Needs you derives its pull request rows and order from the same
modules. The thresholds and the age display rule are named constants.

Ordering is arithmetic over source timestamps. No semantic priority, no persisted review
state, no background poll, and no write to GitHub is introduced. Refresh remains explicit.

## Consequences

The person sees whom each pull request waits on and the oldest ask first, across the rail
and Needs you, from one derivation with table tests. The query returns more per pull
request; the existing page size of thirty stays the bound. A team request shows as held by
the team until a person is picked. Acknowledging, snoozing, parking, triage, and a badge
count remain separate decisions, each needing its own record against ADR-969 and ADR-971.

## Rejected alternatives

- Adopt Flow's server, store and poller: ADR-969 forbids a background poller and a second
  attention store; ADR-040 forbids the runtime dependencies.
- Keep recency ordering and add an age column: the age of the last update is not the age
  of the ask, and the person still sorts the list by hand.
- Count calendar time: a Friday request would turn red over the weekend.
- Infer re-requests or urgency from review prose: source facts do not authorize semantic
  policy (ADR-969).
- Match bot reviewers by name: a person whose login contains "bot" would vanish.
