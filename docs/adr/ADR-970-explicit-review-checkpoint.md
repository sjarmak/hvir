# ADR-970: One explicit review checkpoint per workspace

> Lifecycle: Active
> Supersedes: [ADR-005](ADR-005-system-git-engine.md) | partial | Git mutation scope, for explicit private review-checkpoint object/ref writes only.

## Context

A person returning to agent work needs to distinguish changes made after their last
review from changes they have already seen. HEAD and the staging index are not review
records: a useful baseline includes the workspace's on-disk tracked and non-ignored
untracked files without staging or committing the person's work.

## Decision

The Git capability owns one explicit checkpoint for each canonical host-qualified
workspace. It stores a tree at a workspace-root-keyed ref beneath
`refs/worktree/hvir-review/`. Git owns worktree isolation and object retention; hvir
does not maintain a second history or content database. A checkpoint survives app
restart and branch changes until the person replaces or clears it, or its worktree
is removed. The UI identifies the saved tree without inventing a capture timestamp.

Save, Advance, and Clear are explicit user actions. They do not modify HEAD, branch
refs, the working tree, or the real staging index. Capture preserves raw file bytes,
executable modes, and symlink target bytes rather than following symlink targets.
Ignored untracked files are excluded; tracked files remain included even if ignored.
Sparse checkouts, gitlinks, unsupported entries or encodings, and exceeded limits
fail visibly rather than producing an apparently complete partial checkpoint.

Command planning, tree parsing and comparison remain in the off-thread Git owner.
Main retains `ProjectHost` transport and independently validates every broker call.
One explicit capture creates a checkpoint-only, revocable operation grant scoped to
the exact active project, workspace, root and private ref. It permits bounded raw
blob and tree writes followed by one compare-and-swap ref update, not arbitrary Git
commands. Saves are serialized per workspace. Completion, failure, expiry, authority
loss and disposal revoke the grant. Clear uses an exact single-use ref deletion.

The broker bounds raw chunk reads before feeding bytes to system Git, returning only
object identities to the worker. It validates canonical containment and entry type
before reads and checks for changes afterward. Symlink targets use a narrow host
readlink primitive. Capture uses raw hashing with filters disabled and disables hooks
for its exact ref operation. No temporary index or repository-configured clean filter
is involved. Re-enumeration and content checks detect ordinary concurrent edits; this
is not an atomic filesystem snapshot or a new adversarial no-follow OS guarantee.
Detected churn fails without advancing the previous checkpoint.

The Changes surface requests comparisons only while visible and connected. Reading,
opening or refreshing a checkpoint view never writes Git objects or refs. Live hashes
are compared against the saved tree in memory. File opening revalidates the selected
checkpoint and path; unavailable, binary, oversized or changed inputs are disclosed.
Root changes, disconnect, hiding and renderer disposal revoke view demand and stale
completions cannot restore it. Checkpoints do not create new polling owners.

## Consequences

Review state is durable without becoming a branch, commit workflow, backup tool, or
checkpoint history browser. Capturing a large or actively changing workspace may fail
with an actionable explanation. Failed captures can leave unreachable objects for
Git's normal garbage collection; hvir never runs a destructive repository-wide prune.
Clearing the ref removes the review baseline, not necessarily its object bytes.

Local and SSH paths share the same capability and bounds. Transport limitations must
remain explicit, including symlink targets that cannot be represented exactly by the
SSH adapter. This decision adds no external synchronization or push behavior.

## Rejected alternatives

- Using HEAD or the real index as the baseline: neither represents the person's review.
- Temporary-index `git add`: attributes can transform bytes or invoke clean filters.
- Capturing automatically on view open or refresh: observation would mutate Git state.
- A checkpoint history or app-owned content store: the requirement is one explicit baseline.
- Ambient worker permission to write Git objects: capture authority must end with its operation.
- Reusing architecture-review snapshots: their selected source scope is not a complete workspace baseline.

## References

- [Git worktree ref isolation](https://git-scm.com/docs/git-worktree)
- [Raw object hashing](https://git-scm.com/docs/git-hash-object)
- [Compare-and-swap ref updates](https://git-scm.com/docs/git-update-ref)
