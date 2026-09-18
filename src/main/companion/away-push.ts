/**
 * Away-time Push over the actionable set (ADR-049).
 *
 * While every hvir window is unfocused, a session entering the actionable set
 * produces exactly one Push. The set at construction is the baseline: what was
 * already waiting when hvir started, or when Push was switched on, is not an
 * appearance. A snapshot observed while not away is also only a baseline, so
 * a session that went Ready at the desk never fires on a later blur. A stale
 * entry is never pushed (ADR-048), leaving the set produces nothing, and a
 * failed delivery is reported once and never retried.
 */
import type { ActionableKind } from '../../shared'
import {
  appearances,
  type ActionableAttentionSet,
  type ActionableSnapshot,
  type MainActionableEntry,
} from '../attention/actionable-attention-set'
import type { PushFailureReason, PushMessage, PushSink } from './push-sink'

export type AwayPushResult =
  | { readonly outcome: 'sent' }
  | { readonly outcome: 'failed'; readonly reason: PushFailureReason }
  | {
      readonly outcome: 'skipped'
      readonly reason: 'no-sink' | 'not-described' | 'disposed'
    }
  | { readonly outcome: 'errored'; readonly message: string }

/**
 * One appearance's fate. It names the source's kind, never its key: an
 * external key is a foreign identifier (ADR-046) and outcomes reach logs.
 */
export interface AwayPushOutcome {
  readonly source: 'terminal' | 'external'
  readonly kind: ActionableKind
  readonly result: AwayPushResult
}

export interface AwayPushOptions {
  readonly set: Pick<ActionableAttentionSet, 'observe' | 'snapshot'>
  /** Asked per appearance, so a changed Settings sink applies at once. */
  readonly sink: () => PushSink | undefined
  readonly describe: (entry: MainActionableEntry) => Promise<PushMessage | undefined>
  readonly onOutcome?: (outcome: AwayPushOutcome) => void
}

export class AwayPush {
  private previous: ActionableSnapshot
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly options: AwayPushOptions) {
    this.previous = options.set.snapshot()
    this.unsubscribe = options.set.observe((snapshot) => this.onSnapshot(snapshot))
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  private onSnapshot(next: ActionableSnapshot): void {
    const previous = this.previous
    this.previous = next
    if (!next.away) return
    for (const entry of appearances(previous, next)) {
      if (entry.freshness !== 'fresh') continue
      // Enrichment reads registries and may ask a supervisor; the set's
      // observe callback must not wait on that.
      void this.deliver(entry)
    }
  }

  private async deliver(entry: MainActionableEntry): Promise<void> {
    let result: AwayPushResult
    try {
      result = await this.attempt(entry)
    } catch (error) {
      result = { outcome: 'errored', message: messageOf(error) }
    }
    if (this.disposed) return
    this.options.onOutcome?.({
      source: entry.external === undefined ? 'terminal' : 'external',
      kind: entry.kind,
      result,
    })
  }

  private async attempt(entry: MainActionableEntry): Promise<AwayPushResult> {
    const sink = this.options.sink()
    if (sink === undefined) return { outcome: 'skipped', reason: 'no-sink' }
    const message = await this.options.describe(entry)
    if (message === undefined) return { outcome: 'skipped', reason: 'not-described' }
    if (this.disposed) return { outcome: 'skipped', reason: 'disposed' }
    return await sink.send(message)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
