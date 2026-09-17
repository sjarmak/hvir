# ADR-048: A declared external pending interaction is actionable attention

> Lifecycle: Active
> Supersedes: [ADR-009](ADR-009-hierarchical-attention.md) | partial | Terminal focus as the only rule that clears attention.
> Supersedes: [ADR-019](ADR-019-working-output-is-not-actionable-attention.md) | partial | Actionable workspace, project, and OS attention counts including only distinct terminals.

## Context

ADR-009 built hvir's attention model on generic terminal events: focus clears, parents
aggregate, and priority runs idle-after-submission, then bell, then new output. ADR-019
narrowed the actionable set to terminals with an unseen Ready or bell signal and moved ongoing
post-submission output to a low-salience Working state that never reaches a parent count. Both
records deliberately avoid provider telemetry and screen contents, and ADR-019 states plainly
that Working is heuristic: a chatty command looks active, a quiet one looks Ready.

That model has no vocabulary for the case ADR-046 makes visible. An external agent session
blocked on a question is not producing output, is not idle after a turn the user submitted, and
has no terminal to focus. Under the existing rules it is silent, and silence reads as calm. The
worker waits until someone happens to open the one sidebar that lists it — which is the failure
ADR-046 exists to fix, and the one part of it that surfacing rows alone does not fix, because a
row the user is not looking at raises nothing.

What is new is not another guess. The supervisor states the blocked condition as data: a
pending interaction with its own request identity, a kind, the prompt, and its options
(ADR-047). This is the session authority declaring that it is waiting for a person. ADR-019's
reason for refusing provider turn knowledge was that it would make *generic terminal* attention
inconsistent between harnesses or require parsing the screen. Neither applies here: no terminal
is involved, nothing is parsed, and the declaration arrives uniformly for every session the
supervisor owns regardless of provider.

Extending an attention model to a source hvir does not own also breaks an assumption ADR-009
never had to state, because hvir could always reach anything it flagged. A badge for a foreign
session can be wrong in a way an hvir terminal's badge cannot: the observer can die while the
condition persists, or persist while the condition is resolved elsewhere.

## Decision

### The declared pending interaction is actionable attention

An external session reported by its authority as waiting on a pending interaction carries
actionable attention. It rolls up through workspace, project, and navigation exactly as ADR-009
specifies for a terminal, and it is included in the OS aggregate under ADR-009's existing
all-windows-unfocused rule.

This widens the unit of aggregation from a terminal to a session. ADR-019 replaced ADR-009's
rollup inclusion so that parent and OS counts share one actionable definition; that property is
preserved here rather than traded away, which is why the unit widens for every count together
and not only for the visible parents.

### ADR-019's terminal policy is untouched

Nothing about hvir's own terminals changes. Working remains a low-salience terminal-row state
that never reaches a parent count. Ready and bell remain the only actionable terminal signals,
armed by a submission boundary, with ADR-019's ordering intact. The classifier remains generic
input, output, idle timing, and bell, and it still does not inspect screen contents or depend on
provider telemetry.

This record adds a second, differently-sourced signal alongside that policy. It does not
reclassify any terminal event, and a projected external session is never given a Working state
inferred from its transcript. An external session's actionable state comes only from its
authority's declaration; hvir never derives one from output, timing, or quiet.

### Resolution clears it, not observation

An external pending interaction clears when it is resolved: answered from hvir, answered
elsewhere, or withdrawn because the session moved on. Focusing or selecting the row does not
clear it.

This is the one place the model genuinely departs from ADR-009, and the departure is forced.
Focus clears a terminal's attention because seeing the terminal is the response the signal
asked for. Seeing a blocked agent is not the response it asked for: the agent is still blocked
after the user has looked at it, and a badge that cleared on a glance would hide a live request
for a decision. hvir's own terminals keep focus-clearing unchanged, because for them looking is
still the whole of the response.

### Answering is the only mutation, and it is explicit

The detail pane renders the prompt with its options and answers through the supervisor's
respond operation; a compose box sends a message through its submit operation. These are the
only mutations that cross the Sessions IPC surface for an external session, per ADR-046. No
destructive or lifecycle verb appears in Sessions. Per ADR-047 neither mutation is retried
automatically, because the supervisor deduplicates nothing and a duplicate answer is a real
effect on someone else's agent.

### Staleness is carried, not resolved by assumption

External attention has a provenance and a freshness state, and both travel with it to every
level that displays it, including the badge. When the observing stream is lost, the affected
facts are marked stale with a reason rather than dropped or asserted. A stale pending state is
presented as unconfirmed, and its reason must be reachable from the badge rather than stopping
at the row; a count the user cannot explain is worse than a count that admits what it does not
know.

Neither failure direction may be silently preferred: dropping a real pending interaction hides
a blocked agent, and asserting one nobody is watching sends the user to answer a question that
has already been answered. Recovery is an explicit resumption (ADR-047), never an invisible
re-subscribe that quietly replaces one guess with another.

## Consequences

The case the crew sidebar could not surface at all now reaches the user where attention already
lives: a blocked agent raises the same badges as a terminal waiting on a reply, with Sessions
closed, and answering it clears them without a poll. That closes the loop ADR-046 opened, since
a projected inventory nobody is looking at cannot raise anything by itself.

Attention now has two clearing rules where it had one, which is a real cost in explainability.
It is bounded: the rule is chosen by the row's origin, and both halves are stated as visible
behavior rather than as a special case, consistent with the smart-defaults-exposed-controls
constraint.

hvir's badges now reflect agents hvir did not launch, so a badge can be wrong when a supervisor
disappears. The mitigation is presentational honesty rather than a guarantee, and it obliges
every attention surface — badge included — to be able to say "unconfirmed, and here is why."
That obligation is permanent, and a surface that cannot express staleness is not eligible to
display this signal.

Because the signal is exact and provider-declared rather than heuristic, it does not weaken
ADR-019's position. A future argument for provider-derived *terminal* attention still has to
clear ADR-019's bar on its own; the precedent here is a session hvir does not own, whose
authority states the fact.

Revisit this decision if external attention proves unable to stay fresh enough to be trusted,
if the product accepts provider-derived attention for hvir's own terminals, or if a source
appears that reports a blocked condition only by inference, which this record does not admit.

## Rejected alternatives

- Leaving external sessions out of attention and relying on the Sessions list. The list is a
  surface the user has to already be looking at, which is precisely the condition that made a
  blocked worker invisible.
- Inferring a blocked state from transcript content, quiet after output, or a prompt-shaped
  line. That is the screen parsing ADR-009 and ADR-019 both refuse, and here it is unnecessary
  because the authority declares the fact.
- Giving projected sessions a Working state derived from their transcripts. It reintroduces the
  parent-count noise ADR-019 removed and manufactures a heuristic for a source that offers an
  exact signal.
- Clearing external attention on focus or selection, to keep ADR-009's single rule. The agent
  is still blocked after the glance, so the model would stay simple by being wrong in the one
  case the feature exists for.
- Clearing on any interaction with the row, such as opening its transcript. Reading is not
  answering, and the difference is the whole signal.
- Counting external pending interactions in the visible parents but not the OS aggregate. It
  re-splits the one actionable definition ADR-019 unified, and it withholds the signal exactly
  when the user is not looking at hvir, which is when the OS badge is the only channel left.
- Dropping external attention when the observing stream dies, so a badge is never wrong. A
  blocked agent silently disappears from the one place it was visible.
- Retaining it as confirmed when the stream dies, so the badge stays stable. The user is sent
  to answer a question that may already be answered, and the model claims knowledge it lost.
- Exposing lifecycle or destructive verbs beside the answer control, since the user is already
  there. Enumerating an inventory and controlling its members are different authorities
  (ADR-046), and a misfire here stops someone else's agent.
