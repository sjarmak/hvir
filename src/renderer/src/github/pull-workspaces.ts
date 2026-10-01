import { hostPathEquals, type PullSummary, type WorkspaceState } from '../../../shared'
import type { PullCheckoutsResponse } from '../../../shared/github'

export type PullWorkspaceMatch =
  | { readonly status: 'matches'; readonly workspaces: readonly WorkspaceState[] }
  | { readonly status: 'none' | 'unverified' }

export interface PullWorkspaceNavigation {
  readonly workspaces: readonly WorkspaceState[]
  readonly activeWorkspaceId: string
  readonly open: (workspace: WorkspaceState) => Promise<void>
}

export function resolvePullWorkspaces(
  pull: Pick<PullSummary, 'headRef' | 'headRepo'>,
  response: PullCheckoutsResponse | undefined,
  workspaces: readonly WorkspaceState[],
): PullWorkspaceMatch {
  if (!response?.available || !pull.headRepo) return { status: 'unverified' }
  const candidates = workspaces.filter(
    (workspace) => !workspace.missing && workspace.repository,
  )
  const checkouts = response.checkouts.filter((checkout) =>
    candidates.some((workspace) => hostPathEquals(workspace.root, checkout.root)),
  )
  const matches = checkouts.filter(
    (checkout) =>
      checkout.headRepo?.toLowerCase() === pull.headRepo?.toLowerCase() &&
      checkout.headRef === pull.headRef,
  )
  const matched = candidates.filter((workspace) =>
    matches.some((checkout) => hostPathEquals(workspace.root, checkout.root)),
  )
  if (matched.length > 0) return { status: 'matches', workspaces: matched }
  return {
    status: checkouts.some(
      (checkout) =>
        checkout.branch === pull.headRef && (!checkout.headRepo || !checkout.headRef),
    )
      ? 'unverified'
      : 'none',
  }
}
