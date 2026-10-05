# ADR-974: Create a worktree for a pull request with no checkout

> Lifecycle: Active
> Supersedes: [ADR-005](ADR-005-system-git-engine.md) | partial | Git mutation scope, for one fetch and one tracking worktree add per explicit Create worktree action on a PR row.
> Supersedes: [ADR-008](ADR-008-project-worktree-workspaces.md) | partial | Creating no worktree at all; an explicit Create worktree action on a PR row creates one hvir-owned worktree for that PR.
> Supersedes: [ADR-968](ADR-968-pull-request-workspace-navigation.md) | partial | The PR workspace action creating no checkout; a PR with no verified checkout may offer Create worktree.

## Context

ADR-968 lets a PR row open a workspace that already holds the PR branch. A PR nobody has
checked out locally can only be reached by leaving hvir, creating a worktree with the
correct upstream by hand, and waiting for discovery. Reviewing or continuing a teammate's
or an agent's PR therefore starts outside the workbench.

## Decision

A PR row whose checkout status is "none" offers **Create worktree** when the PR is open and
its head repository is the active GitHub repository. Fork PRs, closed PRs, unverified
checkouts and unavailable checkout reads keep the ADR-968 notes and offer nothing.

The renderer sends only the active workspace root and the PR number. Main looks the PR up
again through `gh pr view`, refuses it unless it is open and not cross-repository, and picks
the remote whose fetch URL names the repository, preferring `origin`. Nothing the renderer
supplies names a branch, path, remote or commit.

The Git mutation coordinator then runs two exact one-shot grants against the registered
root: the existing plain fetch, and
`git worktree add --track -b <head branch> <root>.hvir-worktrees/pr-<number> refs/remotes/<remote>/<head branch>`.
The worktree lives in the sibling directory ADR-963 established. The local branch keeps the
PR head name so that pushing from the worktree updates the PR, and `--track` records the
upstream that ADR-968 matching requires. The broker accepts that argv shape only when the
branch, path and start ref equal the granted target. It refuses any other start point, an
option, or a path outside `pr-<number>` under the owned directory.

Git refuses when a local branch with the PR head name already exists, and the row shows that
error. The coordinator reconciles discovery and returns project state. The row adopts the
state and rereads checkouts, so the existing Open workspace action appears without a new
navigation path.

## Consequences

A same-repository PR is one click from a workspace with correct tracking. Creation changes
local Git state: one new branch, its upstream configuration and one worktree. Removal stays
a terminal task, since hvir never deletes the PR branch, which may carry local commits.
The fetch is the existing plain fetch of the default remote. When the chosen remote is a
different one, the start ref is only as fresh as that remote's last fetch, and Git reports an
invalid reference if the branch was never fetched there.
`pr-<number>` worktrees are not architecture-review handoffs, because their branches sit
outside `hvir/architecture/`, so unfinished-handoff removal never offers them.

## Rejected alternatives

- Support fork PRs by adding a remote per fork owner: it writes lasting remote configuration
  and widens the broker's command grammar. It can be decided separately.
- Fetch `refs/pull/<n>/head` onto a branch with no upstream: ADR-968 matching would never
  recognise it, and pushes could not reach the PR.
- Name the branch `hvir/pr/<n>`: the default push configuration refuses to push when the
  local and upstream names differ.
- Reuse an existing local branch of the same name: its upstream and commits are unverified.
