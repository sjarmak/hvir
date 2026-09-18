/**
 * The one set of sessions waiting on the person, owned by main (ADR-049).
 *
 * Windows report what they present; the external authority reports what it
 * is waiting on; this aggregate dedupes them by source key and says whether
 * hvir is away. Consumers (the OS badge today, the Companion and Push later)
 * observe the same snapshot, so they cannot disagree about what is actionable.
 */

import type {
  ActionableAttentionEntry,
  ActionableFreshness,
  ActionableKind,
  ExternalAttentionStaleReason,
  SessionsTerminalHandle,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { SessionsExternalSessionKey } from '../sessions/sessions-projection-identities'

/** A terminal session id, or `gas-city <hostId> <sessionKey>` for an external session. */
export type ActionableSourceKey = string

export interface MainActionableEntry {
  readonly key: ActionableSourceKey
  readonly kind: ActionableKind
  readonly freshness: ActionableFreshness
  readonly reason?: ExternalAttentionStaleReason
  readonly terminalHandle?: SessionsTerminalHandle
  /** Main only: the foreign identifier this entry stands for. */
  readonly external?: SessionsExternalSessionKey
}

export interface ActionableSnapshot {
  readonly revision: number
  /** No hvir window is focused. Vacuously true before any window exists. */
  readonly away: boolean
  readonly entries: readonly MainActionableEntry[]
}

type SnapshotListener = (snapshot: ActionableSnapshot) => void

export class ActionableAttentionSet {
  private readonly rendererEntries = new Map<
    string,
    readonly ActionableAttentionEntry[]
  >()
  private readonly focus = new Map<string, boolean>()
  private readonly listeners = new Set<SnapshotListener>()
  private external: readonly MainActionableEntry[] = []
  private current: ActionableSnapshot = { revision: 0, away: true, entries: [] }

  setRendererEntries(
    owner: RendererOwner,
    entries: readonly ActionableAttentionEntry[],
  ): void {
    this.rendererEntries.set(ownerKey(owner), entries)
    this.settle()
  }

  removeOwner(ownerId: number, generation?: number): void {
    const keys =
      generation === undefined
        ? [...this.focus.keys(), ...this.rendererEntries.keys()].filter((key) =>
            key.startsWith(`${ownerId}:`),
          )
        : [ownerKey({ id: ownerId, generation })]
    for (const key of keys) {
      this.focus.delete(key)
      this.rendererEntries.delete(key)
    }
    this.settle()
  }

  setFocused(owner: RendererOwner, focused: boolean): void {
    this.focus.set(ownerKey(owner), focused)
    this.settle()
  }

  setExternal(entries: readonly MainActionableEntry[]): void {
    this.external = entries
    this.settle()
  }

  snapshot(): ActionableSnapshot {
    return this.current
  }

  away(): boolean {
    return ![...this.focus.values()].some(Boolean)
  }

  freshCount(): number {
    return this.current.entries.filter((entry) => entry.freshness === 'fresh').length
  }

  observe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  clear(): void {
    this.rendererEntries.clear()
    this.focus.clear()
    this.external = []
    this.settle()
  }

  private settle(): void {
    const entries = this.merge()
    const away = this.away()
    if (away === this.current.away && sameEntries(this.current.entries, entries)) return
    this.current = { revision: this.current.revision + 1, away, entries }
    for (const listener of this.listeners) listener(this.current)
  }

  private merge(): readonly MainActionableEntry[] {
    const byKey = new Map<ActionableSourceKey, MainActionableEntry>()
    // Insertion order is oldest generation first, so a later set wins the key.
    for (const entries of this.rendererEntries.values()) {
      for (const entry of entries) byKey.set(entry.handle, fromRenderer(entry))
    }
    for (const entry of this.external) byKey.set(entry.key, entry)
    return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key))
  }
}

/** Entries present in `next` that `previous` did not carry, in `next` order. */
export function appearances(
  previous: ActionableSnapshot,
  next: ActionableSnapshot,
): readonly MainActionableEntry[] {
  const known = new Set(previous.entries.map((entry) => entry.key))
  return next.entries.filter((entry) => !known.has(entry.key))
}

function fromRenderer(entry: ActionableAttentionEntry): MainActionableEntry {
  return {
    key: entry.handle,
    kind: entry.kind,
    freshness: entry.freshness,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    terminalHandle: entry.handle,
  }
}

function sameEntries(
  left: readonly MainActionableEntry[],
  right: readonly MainActionableEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => fingerprint(entry) === fingerprint(right[index]!))
  )
}

function fingerprint(entry: MainActionableEntry): string {
  return `${entry.key}|${entry.kind}|${entry.freshness}|${entry.reason ?? ''}`
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}
