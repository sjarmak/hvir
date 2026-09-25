# ADR-063: Architecture review over history, with agent worktrees

> Lifecycle: Active
> Supersedes: [ADR-061](ADR-061-pinned-native-architecture-review.md) | partial | The fixed comparison modes, the full recapture on revalidation, and the read-only single-file handoff consumed once per snapshot; pinned evidence, worker isolation, and launch authority remain.
> Supersedes: [ADR-005](ADR-005-system-git-engine.md) | partial | Creating no branch at all; the architecture review creates one hvir/architecture/ branch per agent launch.
> Supersedes: [ADR-008](ADR-008-project-worktree-workspaces.md) | partial | Creating no worktree at all; the architecture review creates one hvir-owned worktree per agent launch.

## Context

The first architecture review (ADR-061) compared the live tree against the index, HEAD, the
branch point or one commit, read every file through the host abstraction one call at a time,
kept nothing between scans, and re-ran the whole capture whenever evidence was opened or a
prompt prepared. Over SSH one scan of hvir itself cost tens of thousands of round trips. The
review could hand one file to an agent, read-only, once per snapshot, and nothing came back.

The person reviewing wants to choose any two points in history, step along commits, see change
at the subsystem level first, review projects in Go, Python and Rust as well as TypeScript,
and let an agent improve the architecture from inside the review with the review as the
verification loop.

## Decision

**Two ends, any refs.** A snapshot compares a Baseline to a Current end. Either end may be any
commit reachable in the repository; only the Current end may be the live working tree. Both
tree ends are read from Git objects by one listing and one batched blob read per side; no
checkout or worktree is needed to compare history. A commit strip lists the range from the
merge-base with the default branch to HEAD by default, widenable by ref, and steps either
pairwise or against a locked baseline.

**Nothing is read twice.** The live side is read by one batched host command per scan. Parsed
module facts are cached on disk per host and repository, keyed by blob identity and scanner
version, bounded in size, and evicted least-recently-used. Snapshots themselves stay
ephemeral and pinned to exact bytes as ADR-061 requires. Every scan records per-stage
timings and transfer sizes and shows them in the snapshot details.

**Freshness only where it can change.** A snapshot whose two ends are commits is never stale.
A snapshot whose Current end is the live tree is checked by HEAD identity, index digest and
a porcelain status, not by recapture. Opening evidence and preparing a prompt never recapture.

**Subsystem first, full graph always.** The map opens on relationships between subsystems
and drills down to modules and import evidence. Both sides always carry the full import
graph within the chosen scope; relationships are never computed from changed files alone.
The subsystem unit defaults to the first directory under the source root; a tracked file in
the repository may override the mapping and record the scan scope. Above the size cap the
review refuses and asks for a narrower scope; it never truncates silently.

**Many languages, one contract.** Scanning is defined by a language-agnostic contract from
files to modules and import facts. TypeScript and JavaScript keep the compiler-based scanner
with the captured tsconfig applied to resolution. Other languages use web-tree-sitter
grammars in the same utility process, in the order Python, Go, Rust. A Go module is a package
directory; a Python module is a file within its package directory; a Rust module is a file
within its crate.

**The agent works in a worktree hvir owns.** On launch, hvir creates a worktree and branch
through its mutation authorization path, writes an untracked snapshot brief into it holding
the subsystem deltas, changed relationships and evidence paths, and starts the provider
session there with a prompt that points at the brief. The worktree appears as an ordinary
worktree tab. Because hvir created it, no report from the agent is needed: the review can
re-snapshot the worktree at any time, by default against the original Current end to show
only the agent's change, and one click away against the original Baseline to show the
cumulative result. Direct edits to the person's working tree remain excluded.

**The person removes an unfinished handoff; hvir never does.** A handoff interrupted after
its worktree was created but before its brief landed leaves a worktree no agent ever ran in.
The workspace list labels it "unfinished handoff", judged from disk and Git alone: its branch
is `hvir/architecture/<slug>` at the one location a handoff creates, resolving to itself and
not the main tree; no hvir terminal session is recorded or running in it; the brief is
absent; the branch reflog holds only its creation entry, at HEAD; and `git status` reports
nothing, ignored files included. Removal happens only when the person confirms it on that
tab, and only through two exact one-shot grants: `git worktree remove` without `--force`,
then deletion of the branch only while it still points at its creation commit. Main re-reads
every fact before each removal and refuses the main working tree, the active workspace, any
branch outside the prefix, any path outside the owned location, and any worktree that no
longer qualifies. This is the only removal authority the review holds.

## Consequences

History comparison becomes a git-object read plus a cache lookup, so stepping the strip is
cheap after the first parse. The disk cache is new state to bound and to invalidate on
scanner upgrades. web-tree-sitter adds a WebAssembly dependency and per-language grammars to
package. Worktree creation is a new write authority for the review; ADR-061's read-only
promise no longer holds for the review as a whole, though it still holds for the person's own
working tree. The one-shot launch rule is replaced by one worktree per launch. The narrow,
person-triggered removal of an unfinished handoff is the one delete authority added beside
it; a worktree with any commit, change, brief or session is never removed by hvir, so an
interrupted handoff with work in it stays until the person deals with it in Git.

## Rejected alternatives

- Running native toolchains (go list, python ast, cargo metadata) on each host: fails
  wherever a toolchain is missing and duplicates the scanner per host.
- Line-level import extraction without a parser: misses re-exports, conditional imports and
  Rust module trees.
- Changed-files-only capture: fast and wrong; relationship counts need both full graphs.
- Persisting whole snapshots: duplicates what the blob cache gives and weakens the
  pinned-bytes guarantee.
- Letting the agent create its own worktree and report back: needs a result channel that
  hvir owns anyway once it created the worktree.
- Silent truncation over the size cap: makes the map lie.
