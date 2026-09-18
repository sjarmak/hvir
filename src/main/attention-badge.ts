import type { ActionableAttentionSet } from './attention/actionable-attention-set'

/**
 * The OS badge, one consumer of the actionable set (ADR-049). It counts fresh
 * entries while hvir is away and shows nothing while a window is focused; a
 * stale entry is the last thing seen, not a claim, so it never counts.
 */
export class AttentionBadge {
  private lastRendered = -1
  private failed = false
  private readonly stop: () => void | Promise<void>

  constructor(
    private readonly setBadgeCount: (count: number) => boolean | void,
    private readonly source: Pick<ActionableAttentionSet, 'observe' | 'snapshot'>,
  ) {
    this.stop = source.observe(() => this.render())
    this.render()
  }

  dispose(): void {
    void this.stop()
    this.paint(0)
  }

  private render(): void {
    const snapshot = this.source.snapshot()
    if (!snapshot.away) {
      this.paint(0)
      return
    }
    const fresh = snapshot.entries.filter((entry) => entry.freshness === 'fresh').length
    this.paint(Math.min(99, fresh))
  }

  private paint(count: number): void {
    if (count === this.lastRendered) return
    this.lastRendered = count
    if (this.failed) return
    try {
      if (this.setBadgeCount(count) === false) this.failed = true
    } catch (error) {
      this.failed = true
      console.warn('[attention] OS badge unavailable', error)
    }
  }
}
