# ADR-065: History reads the fleet's commit classification

> Lifecycle: Active
> Supersedes: [ADR-063](ADR-063-architecture-review-history-and-agent-worktrees.md) | partial | Marking every History row and strip commit from its diff and import edges alone; a commit the fleet has classified is marked from its Architectural trailer instead.

## Context

ADR-063 marks each History row and strip commit with one flat value, architecture, code, none
or unclassified, decided by a heuristic in main from the commit's diff and the import edges of
its modified modules. That marker counts every import relationship, test files and outside
libraries included, and on hvir's own history it called 26 of the newest 50 commits
architecture changes, more than a reviewer wants to open.

The person reviewing asked for more than a flat marker (decision dec-0mhh on the gas-city
decisions rig, 2026-09-27, which holds the full taxonomy): one primary change type per change
(Architecture, Data model / persistence, Interface / contract, Dependency, Control flow /
behavior, Feature, Bug fix, Performance, Reliability / resilience, Security / permissions,
Observability, Refactor, Configuration / deployment, Tests / validation, Documentation) and
five orthogonal dimensions annotated on every change: scope (local, module, subsystem,
cross-system), architectural significance (none, structural, architectural), behavioral
effect, compatibility and risk. Architecture is both a primary type and the significance
dimension, because a flat list loses information: adding Redis caching is Performance and
architectural, replacing a REST call with an event queue is Architecture and architectural,
adding a database index is Performance and not architectural. She also wants intent kept
apart from implementation: one semantic change classified once, with its forty file edits
associated to it, rather than every file edit classified on its own.

The classification is being built fleet-wide, not in hvir (dr-wbtfj, assigned to
city-infra-pl). Every repository the fleet owns gets git trailers on new commits,
Change-Type, Change-Scope, Architectural, Behavior, Compatibility, Risk, one Bead line per
contributing bead, and Classified-By, checked by a commit-msg hook; history is backfilled by
an evaluation model into git notes under refs/notes/classification, with no history rewrite.
hvir is a viewer; it renders from that data and computes none of it. As of this decision no
repository, hvir included, has the notes ref yet, and most of hvir's history may never be
backfilled.

## Decision

**hvir reads the fleet's classification; it never computes, backfills or stores one.** For
each batch of commits History or the strip asks about, main reads one `git log` over the
batch with `--notes=refs/notes/classification`, taking the commit's own trailers and its note
in the same call. No model is called, no network is used, and no second store is written. A
commit is classified when its note or its message carries a Change-Type trailer; the other
fields are optional. The note wins over the message: a note on a commit that already labelled
itself can only have been written on purpose, so it is read as a correction, and corrections
need no history rewrite. Trailer values are read as the fleet wrote them, trimmed, one line
each, bounded in length; hvir does not validate them against the taxonomy, so a value the
fleet spells differently is shown as written rather than dropped.

**Absence is ordinary.** A missing notes ref, a commit with no note and no trailers, and a
note without a Change-Type are all the same "not classified" answer, never an error. Git
exits cleanly for a notes ref that does not exist, so the read costs one command per batch
whether or not the fleet has reached the repository.

**The heuristic is the permanent fallback, not a shim.** A commit the fleet has not classified
is marked exactly as ADR-063 marks it: from its diff and the import edges of its modified
modules, cached by commit pair, scanner versions and layout. Nothing in that path is weakened
or removed. Most of hvir's history may never be backfilled, and every repository the fleet
does not own is in the same position, so the heuristic stays as long as the marker does.

**A classified commit is marked from its Architectural trailer.** Where the fleet has
classified a commit, the flat marker follows the architectural-significance dimension instead
of the heuristic: architecture when the value is `architectural`; otherwise code when a source
in scope was added, removed, renamed or modified, and none when nothing in scope changed.
Structural significance does not set the marker; a rename or extraction that keeps the
architecture is what the heuristic over-marked. Classified commits skip the module reads and
pair scans entirely and are not cached, so a note that lands later takes effect on the next
request. The filter "Architecture changes only" therefore follows the fleet where the fleet
has spoken and the heuristic elsewhere.

**The classification travels with the marker.** Each answer carries the fleet fields beside
the flat marker, over the same IPC channel, in the same store, under the same head
invalidation. History and the strip label a classified commit by its change type and describe
the dimensions on the marker itself, in the shape the person asked for:
`Performance · Architectural · Subsystem · Compatible · Low risk`, with behavior, beads and
the classifier beneath. The full filter panel (change type, architectural, scope, breaking,
risk) waits for real fleet data to filter over and is follow-up work; nothing in the store
shape prevents it.

**Bead is the intent.** Commits sharing a Bead trailer are one semantic change. Grouping
History by that trailer, and associating each commit's files and hunks with that one
classification, is how hvir will show intent apart from implementation; it is follow-up work
on the same read path, and hvir will not invent a grouping model of its own.

## Consequences

A classified commit costs no module reads and no scans, so a backfilled history is cheaper to
mark than an unlabelled one, and the marker is always the fleet's where the fleet has one.
Every classification batch gains one git command, whether or not the notes ref exists; Git
prints a warning for the absent ref on stderr, which main ignores as it does for every
successful command. Two sources now feed one marker; the ADR-063 heuristic and the fleet can
disagree on the same commit, and the fleet wins by design, so a disagreement is a signal about
the fleet's label, not a bug in the marker. hvir's own trailer parsing is the one piece of
reading logic it owns: a `Key: value` line grammar with folded continuations, shared by
message trailers and notes; when the fleet publishes a reader or a spec that differs, this
parser follows the spec. The taxonomy values are not an enum in hvir; a filter panel will need
the fleet's spelling, which is a reason to add the panel only once real data exists. Notes are
local to a clone: a repository whose notes ref has not been fetched shows the heuristic, and
hvir does not fetch.

## Rejected alternatives

- Classifying commits in hvir with an evaluation model: builds the fleet's engine a second
  time, puts a model call and a network dependency in a viewer, and diverges from every other
  tool reading the same trailers.
- A second store of hvir's own (a sidecar file or the parse cache) for classifications: a
  second source of truth to sync with the notes ref, and a place for hvir to drift from the
  fleet.
- Mapping change types to markers (Documentation to none, Tests to none, Refactor to code): a
  semantic judgement in code, and one the fleet's Architectural dimension already makes; the
  marker follows that dimension and the diff only.
- Reading only the notes ref: the fleet labels new commits in their messages and backfills
  only the rest, so a notes-only reader would go blind exactly where labelling is required.
- Preferring the message over the note: leaves no way to correct a mislabelled commit without
  rewriting history.
- Replacing the heuristic once the backfill runs: the backfill covers fleet repositories; hvir
  reviews any repository, and most of hvir's own history may never be labelled.
- Building the filter panel now: there is no fleet data to filter over, and the value
  spellings it would filter on are not yet observed.
- Validating trailer values against the taxonomy and dropping the rest: turns a spelling
  difference between hvir and the fleet into a silently unclassified commit.
