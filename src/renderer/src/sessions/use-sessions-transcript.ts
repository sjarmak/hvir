import { useEffect, useRef, useSyncExternalStore } from 'react'

import type { SessionsProjectionSnapshot } from '../../../shared'
import {
  SessionsTranscriptCoordinator,
  createSessionsTranscriptMainPort,
} from './sessions-transcript-coordinator'

export function useSessionsTranscript({
  snapshot,
  foreground,
}: {
  readonly snapshot: SessionsProjectionSnapshot
  readonly foreground: boolean
}) {
  const reference = useRef<SessionsTranscriptCoordinator | undefined>(undefined)
  reference.current ??= new SessionsTranscriptCoordinator(
    createSessionsTranscriptMainPort(window.hvir),
  )
  const coordinator = reference.current
  const state = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.snapshot,
    coordinator.snapshot,
  )
  useEffect(
    () => coordinator.synchronize(snapshot, foreground),
    [coordinator, foreground, snapshot],
  )
  // The demand is released when the pane goes away, so a hidden Sessions holds
  // no transcript stream at all.
  useEffect(() => () => coordinator.close(), [coordinator])
  return { coordinator, state }
}
