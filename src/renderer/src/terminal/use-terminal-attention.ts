import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ACTIONABLE_ATTENTION_VERSION,
  EMPTY_RENDERER_ATTENTION_SET,
  MAX_ACTIONABLE_ENTRIES,
  type ActionableAttentionEntry,
  type RendererAttentionSet,
} from '../../../shared'
import type {
  WorkspaceAttentionRollup,
  WorkspaceAttentionRollups,
} from '../workspaces/project-session-model'
import { actionableEntriesFingerprint } from './terminal-attention'

/**
 * Terminal attention rollups, and what this window tells main is waiting.
 *
 * The window sends the entries, not a count (ADR-049): main dedupes them
 * across windows, decides whether hvir is away, and drives the OS badge, the
 * Companion and Push from one set. External attention is not sent from here;
 * main already holds it at the authority that raised it.
 */
export function useTerminalAttention() {
  const [rollups, setRollups] = useState<WorkspaceAttentionRollups>({})
  const updateRollup = useCallback(
    (workspaceId: string, rollup: WorkspaceAttentionRollup): void => {
      setRollups((current) => {
        const existing = current[workspaceId]
        if (
          existing?.actionable === rollup.actionable &&
          existing.working === rollup.working &&
          actionableEntriesFingerprint(existing.entries) ===
            actionableEntriesFingerprint(rollup.entries)
        ) {
          return current
        }
        return { ...current, [workspaceId]: rollup }
      })
    },
    [],
  )
  const set = rendererAttentionSet(rollups)
  const fingerprint = actionableEntriesFingerprint(set.entries)
  const setRef = useRef(set)
  setRef.current = set

  useEffect(() => {
    window.hvir.send('app:attention', setRef.current)
  }, [fingerprint])
  useEffect(
    () => () => window.hvir.send('app:attention', EMPTY_RENDERER_ATTENTION_SET),
    [],
  )

  return { rollups, updateRollup }
}

/** Every workspace's entries as one set, each terminal once, within the cap. */
function rendererAttentionSet(rollups: WorkspaceAttentionRollups): RendererAttentionSet {
  const seen = new Set<string>()
  const entries: ActionableAttentionEntry[] = []
  for (const rollup of Object.values(rollups)) {
    for (const entry of rollup.entries) {
      if (seen.has(entry.handle) || entries.length >= MAX_ACTIONABLE_ENTRIES) continue
      seen.add(entry.handle)
      entries.push(entry)
    }
  }
  return { version: ACTIONABLE_ATTENTION_VERSION, entries }
}
