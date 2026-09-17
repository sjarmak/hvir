/**
 * The external attention the main process is holding, followed continuously.
 *
 * Always subscribed: the facts behind it follow open projects rather than a
 * view, so the nav can show a blocked agent without the Sessions list ever
 * having been opened (ADR-048). A snapshot that fails to validate is ignored
 * rather than rendered, and a failed read leaves the last snapshot in place.
 */
import { useEffect, useRef, useState } from 'react'

import { EMPTY_EXTERNAL_ATTENTION, isExternalAttentionSnapshot } from '../../../shared'
import {
  externalAttentionByWorkspace,
  type ExternalWorkspaceAttention,
} from './external-attention'

export function useExternalAttention(): ExternalWorkspaceAttention {
  const [attention, setAttention] = useState<ExternalWorkspaceAttention>(() =>
    externalAttentionByWorkspace(EMPTY_EXTERNAL_ATTENTION),
  )
  const eventRevision = useRef(0)

  useEffect(() => {
    let active = true
    const accept = (candidate: unknown): void => {
      if (!active || !isExternalAttentionSnapshot(candidate)) return
      setAttention(externalAttentionByWorkspace(candidate))
    }
    const unsubscribe = window.hvir.on('gascity:attention-changed', (candidate) => {
      eventRevision.current++
      accept(candidate)
    })
    // A push that lands while the first read is in flight wins: it is the newer
    // of the two, and the read cannot know that.
    const requestedAtRevision = eventRevision.current
    void window.hvir
      .invoke('gascity:attention', undefined)
      .then((candidate) => {
        if (eventRevision.current === requestedAtRevision) accept(candidate)
      })
      .catch(() => {})
    return () => {
      active = false
      void unsubscribe()
    }
  }, [])

  return attention
}
