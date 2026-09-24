# ADR-062: Maintained branch local verification

> Lifecycle: Active
> Supersedes: [ADR-040](ADR-040-complete-source-budgets-and-dependency-policy.md) | partial | Local architecture provenance on the Beads-governed feat/beads-panel branch; upstream delivery and all structural checks remain unchanged.

## Context

The maintained `feat/beads-panel` branch tracks custom-feature implementation in Beads.
Upstream GitHub issues and pull requests are not its local acceptance authority. Requiring
an upstream issue worktree and GitHub token makes local verification unavailable even when
all source budgets, dependency rules, and application checks can run locally.

## Decision

Local `npm run verify` on exactly `feat/beads-panel` uses the maintainer-approved architecture
policy at commit `912cc42e1c41f431bc0d4c8a78cfaf0ca7c6c138` as its fixed baseline. This
baseline identifies the existing policy, not a dynamically selected HEAD or caller-supplied
ref. It must exist locally and be an ancestor of the candidate. Beads owns local work tracking;
its mutable notes and status are not inputs that authorize architecture budget changes.

Reuse the existing architecture inventory, policy validation, generated ownership, historical
ratchets, module graph, and forbidden dependency checks. Dirty source remains subject to all
checks. A policy relaxation cannot authorize itself in this mode, even in a policy-only change.
Changing the pinned baseline requires a separate maintainer decision. Transitional exceptions
requiring live upstream removal-issue evidence are unsupported locally and fail explicitly.

The report names the maintained-branch mode, immutable baseline and candidate, and lack of
upstream delivery authority. Recheck branch and candidate identity during verification.

GitHub Actions always uses the existing upstream PR provenance path, including on this branch.
Other local branches and detached checkouts also retain existing upstream rules. There is no
CLI flag, environment override, guessed issue, or fabricated PR event to select local authority.
This decision grants no publishing, merge, release, or upstream policy acceptance authority.

## Consequences

The maintained branch can run normal blocking verification without GitHub credentials or an
upstream issue. New source, increased counts, invalid generated ownership, unresolved imports,
cycles, and forbidden directions remain failures under the same evaluators.

The fixed baseline must remain available in Git history. Rebasing away from it or needing a
budget relaxation requires deliberate policy maintenance. This is a narrow branch-specific
exception, not a general alternate governance framework.

## Rejected alternatives

- Skipping architecture enforcement or using provisional reporting: loses blocking checks.
- Pretending the branch is an upstream issue or epic: misrepresents delivery authority.
- Using HEAD as the accepted baseline: lets a consuming commit authorize its own relaxed policy.
- Automatically trusting Bead status or notes: mutable tracking data is not policy acceptance.
