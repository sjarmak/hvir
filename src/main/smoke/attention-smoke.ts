import type { RendererAttentionSet } from '../../shared'
import { ActionableAttentionSet } from '../attention/actionable-attention-set'
import { AttentionBadge } from '../attention-badge'
import type { RendererOwner } from '../renderer-resource-scopes'

/** One window's `app:attention` send, as the smoke IPC surface received it. */
export interface RecordedAttentionUpdate {
  readonly owner: RendererOwner
  readonly set: RendererAttentionSet
}

export interface SmokeAttention {
  /** The real aggregate, fed by the smoke IPC deps exactly as production is. */
  readonly set: ActionableAttentionSet
  /** Every badge count the aggregate asked the desktop to draw, in order. */
  readonly badgeCounts: readonly number[]
  /** Every renderer set the IPC router handed over, in order. */
  readonly updates: readonly RecordedAttentionUpdate[]
  readonly updateAttention: (owner: RendererOwner, set: RendererAttentionSet) => void
  readonly setOwnerFocused: (owner: RendererOwner, focused: boolean) => void
  readonly dispose: () => void
}

/**
 * Production attention wiring for the smoke build, with the desktop replaced
 * by a recorder. A scenario reads what the window sent and what the badge
 * would have shown; nothing here touches the dock of the machine running it.
 */
export function createSmokeAttention(): SmokeAttention {
  const set = new ActionableAttentionSet()
  const badgeCounts: number[] = []
  const updates: RecordedAttentionUpdate[] = []
  const badge = new AttentionBadge((count) => {
    badgeCounts.push(count)
    return true
  }, set)
  return {
    set,
    badgeCounts,
    updates,
    updateAttention: (owner, next) => {
      updates.push({ owner, set: next })
      set.setRendererEntries(owner, next.entries)
    },
    setOwnerFocused: (owner, focused) => set.setFocused(owner, focused),
    dispose: () => {
      badge.dispose()
      set.clear()
    },
  }
}
