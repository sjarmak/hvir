/**
 * Composition seam for application attention (ADR-049).
 *
 * Owns the actionable set and its first consumer, the OS badge, and feeds the
 * set from the two sources: windows, through the IPC deps this returns, and
 * the Gas City attention rollup's pending sessions. The Companion and Push
 * observe the same set later; nothing else composes attention.
 */
import type { RendererAttentionSet } from '../../shared'
import { AttentionBadge } from '../attention-badge'
import type { ExternalPendingSession, GasCityAttention } from '../gascity/city-attention'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { WorkbenchRuntime } from '../workbench-runtime'
import {
  ActionableAttentionSet,
  type MainActionableEntry,
} from './actionable-attention-set'

export interface ApplicationAttentionOptions {
  readonly gasCityAttention: Pick<GasCityAttention, 'pendingSessions' | 'observePending'>
  readonly setBadgeCount: (count: number) => boolean | void
  /** Defaults to the running platform; only the desktops with a badge are asked. */
  readonly platform?: NodeJS.Platform
}

export interface ApplicationAttention {
  readonly set: ActionableAttentionSet
  readonly badge: AttentionBadge
  updateAttention(owner: RendererOwner, set: RendererAttentionSet): void
  setOwnerFocused(owner: RendererOwner, focused: boolean): void
  removeOwner(owner: RendererOwner): void
}

export function installApplicationAttention(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  options: ApplicationAttentionOptions,
): ApplicationAttention {
  const set = runtime.own(
    'actionable attention set',
    new ActionableAttentionSet(),
    (held) => held.clear(),
  )
  const badge = runtime.own(
    'attention badge',
    new AttentionBadge(badgeSink(options), set),
    (held) => held.dispose(),
  )
  const syncExternal = (): void => {
    set.setExternal(options.gasCityAttention.pendingSessions().map(externalEntry))
  }
  runtime.own(
    'external attention subscription',
    options.gasCityAttention.observePending(syncExternal),
    (stop) => stop(),
  )
  // The rollup may have published before this seam existed; read it now
  // rather than wait for the next change.
  syncExternal()
  return {
    set,
    badge,
    updateAttention: (owner, next) =>
      set.setRendererEntries(owner, next.entries, next.working),
    setOwnerFocused: (owner, focused) => set.setFocused(owner, focused),
    removeOwner: (owner) => set.removeOwner(owner.id, owner.generation),
  }
}

function badgeSink(
  options: Pick<ApplicationAttentionOptions, 'setBadgeCount' | 'platform'>,
): (count: number) => boolean | void {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') return () => false
  return options.setBadgeCount
}

function externalEntry(session: ExternalPendingSession): MainActionableEntry {
  return {
    key: `gas-city ${session.hostId} ${session.sessionKey}`,
    // A pending interaction is a turn waiting on the person, whatever gc
    // calls it; the word travels with the session, not the entry.
    kind: 'ready',
    freshness: session.freshness,
    ...(session.reason === undefined ? {} : { reason: session.reason }),
    external: { sourceId: 'gas-city', hostId: session.hostId, key: session.sessionKey },
  }
}
