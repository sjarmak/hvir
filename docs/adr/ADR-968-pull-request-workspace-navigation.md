# ADR-968: Pull request shortcuts to existing workspaces

> Lifecycle: Active
> Supersedes: [ADR-008](ADR-008-project-worktree-workspaces.md) | partial | Workspace selection existing only in the top tier, for explicit PR-row shortcuts into the existing workspace navigation owner.

## Context

A person reviewing pull requests needs to reach the checkout and terminals where that work
is happening. Branch names can collide across forks, and local branch names can differ from
their upstream names. A PR link alone does not identify a workspace.

## Decision

The PRs rail offers an explicit workspace action alongside the GitHub link. Its navigation
uses the existing workspace session switch or reopen action. The top project/workspace tier
remains the general navigation surface and displays the resulting selection.

The GitHub capability reads bounded worktree and upstream metadata through `ProjectHost`.
An association requires the PR head repository and branch to match a checkout's configured
upstream repository and branch. The renderer intersects those results with present workspaces
in the current registered project using host-qualified roots. No branch-name-only or commit-SHA
fallback is allowed. Missing tracking identity and failed reads are unverified states.

One confirmed match offers Open workspace; a closed match offers Reopen workspace; the current
workspace is labeled; multiple confirmed matches offer an explicit path chooser. No confirmed
checkout and unavailable verification remain distinct. A click revalidates the checkout before
navigation, and completions after departure or disconnection cannot navigate.

The action creates no checkout, changes no Git branch, starts no terminal, and preserves the
existing workspace state and live-session lifecycle. Reopen continues to obey ADR-023 and does
not resurrect terminals forgotten on close.

## Consequences

PR review gains a direct route into existing work without introducing another workspace owner.
Forks and renamed local branches are supported when tracking is configured. An untracked branch
cannot be inferred to belong to a PR; the user can still select its workspace in the top tier.
Read-only Git work is demand-driven by the visible PR panel and explicit navigation.

## Rejected alternatives

- Replace the PR title link with workspace navigation: this would hide the existing GitHub action.
- Match branch names or commits alone: forks may share names and local work may be unpushed.
- Create or switch Git checkouts: this shortcut is navigation into existing workspaces.
- Add a separate workspace lifecycle inside the PR panel: selection and reopening already have owners.
