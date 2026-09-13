import { useEffect, useRef } from 'react'

import {
  resolveTerminalAttach,
  type TerminalAttachRequest,
  type TerminalWorkspaceModel,
} from './terminal-workspace-model'

export interface TerminalAttachPorts {
  /** The live model at fire time; the hook must not read a stale render's copy. */
  readonly currentModel: () => TerminalWorkspaceModel
  readonly focusSession: (id: string) => void
  /**
   * Open a shell running `command`, returning its session id — or `undefined`
   * when the workspace is not ready to launch one.
   */
  readonly launch: (command: string) => string | undefined
  /** Whether `launch` would currently open a shell (a default harness exists). */
  readonly canLaunch: boolean
  /** Told when `canLaunch` changes, so the requester can disable its actions. */
  readonly reportAvailability?: (canLaunch: boolean) => void
}

/**
 * Serve one attach request per distinct nonce: a re-render with the same
 * request never re-fires, but a fresh nonce (even for the same command) does.
 *
 * A keyed request names a crew identity, and the hook remembers the terminal it
 * opened for that key — so a second click focuses the live session instead of
 * piling up another shell. Unkeyed requests are one-shot commands and always get
 * a fresh terminal.
 */
export function useTerminalAttachRequest(
  attachRequest: TerminalAttachRequest | undefined,
  ports: TerminalAttachPorts,
): void {
  const lastNonce = useRef<number | undefined>(undefined)
  const launchedByKey = useRef(new Map<string, string>())
  const portsRef = useRef(ports)
  portsRef.current = ports

  useEffect(() => {
    if (!attachRequest || lastNonce.current === attachRequest.nonce) return
    lastNonce.current = attachRequest.nonce
    const { currentModel, focusSession, launch } = portsRef.current
    const outcome = resolveTerminalAttach(
      attachRequest,
      launchedByKey.current,
      currentModel(),
    )
    if (outcome.type === 'focus') {
      focusSession(outcome.id)
      attachRequest.onSettled?.(true)
      return
    }
    const launched = launch(attachRequest.command)
    if (launched !== undefined && attachRequest.key !== undefined) {
      launchedByKey.current.set(attachRequest.key, launched)
    }
    attachRequest.onSettled?.(launched !== undefined)
    // Ports are read through a ref so only a fresh nonce re-runs this effect.
  }, [attachRequest])

  // Availability is pushed, not polled: the requester lives outside this
  // workspace and otherwise learns that nothing can launch only by watching a
  // request vanish.
  const { canLaunch } = ports
  useEffect(() => {
    portsRef.current.reportAvailability?.(canLaunch)
  }, [canLaunch])
}
