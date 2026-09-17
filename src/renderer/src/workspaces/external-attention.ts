/**
 * External agent attention, aggregated the way terminal attention is.
 *
 * An agent waiting on a person is the same kind of signal as a terminal waiting
 * on one, so it aggregates through workspace, project, and nav identically
 * (ADR-009). It is kept separate from the terminal rollups on purpose: the two
 * counts are described differently to a person, and a stale external count is
 * not eligible for the OS badge, which cannot say that it is stale (ADR-048).
 */
import type { ExternalAttentionEntry, ExternalAttentionSnapshot } from '../../../shared'

/** What one workspace, project, or the nav is waiting on, external to hvir. */
export interface ExternalAttentionTotal {
  readonly waiting: number
  /** The count is the last thing hvir saw, not a claim about now. */
  readonly stale: boolean
  /** Why hvir stopped watching. Present whenever the total is stale. */
  readonly reason?: string
}

export type ExternalWorkspaceAttention = Readonly<Record<string, ExternalAttentionEntry>>

export const NO_EXTERNAL_ATTENTION: ExternalWorkspaceAttention = {}

export function externalAttentionByWorkspace(
  snapshot: ExternalAttentionSnapshot,
): ExternalWorkspaceAttention {
  const byWorkspace: Record<string, ExternalAttentionEntry> = {}
  for (const entry of snapshot.entries) byWorkspace[entry.workspaceId] = entry
  return byWorkspace
}

export function workspaceExternalAttention(
  workspaceId: string,
  attention: ExternalWorkspaceAttention,
): ExternalAttentionTotal {
  return totalOf(attention[workspaceId])
}

/**
 * One project's, or the whole nav's, external attention. A single stale
 * contribution makes the total stale: a count that is part unverified is
 * unverified, and the reason shown is the first one, because a person needs a
 * reason rather than all of them.
 */
export function aggregateExternalAttention(
  workspaceIds: readonly string[],
  attention: ExternalWorkspaceAttention,
): ExternalAttentionTotal {
  const totals = workspaceIds.map((workspaceId) =>
    workspaceExternalAttention(workspaceId, attention),
  )
  return {
    waiting: totals.reduce((sum, total) => sum + total.waiting, 0),
    stale: totals.some((total) => total.stale),
    ...reasonOf(totals.find((total) => total.reason !== undefined)?.reason),
  }
}

/**
 * The external contribution to the OS badge: the interactions hvir is watching
 * right now, and nothing stale. A dock badge is a number with nowhere to put a
 * reason, so a count it cannot qualify does not belong in it (ADR-048).
 */
export function liveExternalAttentionTotal(
  attention: ExternalWorkspaceAttention,
): number {
  return Object.values(attention).reduce(
    (sum, entry) => sum + (entry.stale === true ? 0 : entry.waiting),
    0,
  )
}

/** How a stale external count says why, in a title or an accessible name. */
export function externalAttentionLabel(total: ExternalAttentionTotal): string {
  const waiting = `${total.waiting} agent${total.waiting === 1 ? '' : 's'} waiting on you`
  if (!total.stale) return waiting
  return `${waiting} · last seen before the connection ${staleWord(total.reason)}`
}

function totalOf(entry: ExternalAttentionEntry | undefined): ExternalAttentionTotal {
  if (entry === undefined) return { waiting: 0, stale: false }
  return {
    waiting: entry.waiting,
    stale: entry.stale === true,
    ...reasonOf(entry.reason),
  }
}

function reasonOf(reason: string | undefined): { readonly reason?: string } {
  return reason === undefined ? {} : { reason }
}

/**
 * The reason in a person's words. Every code the main process can send is
 * covered, so a badge never shows a raw vocabulary word.
 */
function staleWord(reason: string | undefined): string {
  switch (reason) {
    case 'closed':
      return 'closed'
    case 'unreachable':
    case 'timeout':
    case 'aborted':
      return 'was lost'
    case 'disabled':
    case 'misconfigured':
    case 'city-unknown':
    case 'not-found':
      return 'stopped being available'
    case 'denied':
      return 'was refused'
    case 'unready':
    case 'faulted':
    case 'conflict':
    case 'rejected':
    case 'protocol':
    case 'unsupported':
      return 'stopped answering'
    default:
      return 'ended'
  }
}
