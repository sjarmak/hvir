import { useEffect, useRef } from 'react'

import {
  isExternalSessionAttachTicketRequest,
  type ExternalSessionAttachRequest,
  type ExternalSessionAttachTarget,
} from '../../../shared'
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
   * when the workspace is not ready to launch one. `externalAttach` records
   * what the shell is attaching to, so the terminal can be recognized as that
   * session's for the rest of its life, not just this renderer's.
   */
  readonly launch: (
    command: string,
    externalAttach?: ExternalSessionAttachRequest,
  ) => string | undefined
  /** Which of this workspace's terminals main has recorded against `attach`. */
  readonly resolveAttached: (
    attach: ExternalSessionAttachTarget,
  ) => Promise<readonly string[]>
  /** Whether `launch` would currently open a shell (a default harness exists). */
  readonly canLaunch: boolean
  /** Told when `canLaunch` changes, so the requester can disable its actions. */
  readonly reportAvailability?: (canLaunch: boolean) => void
}

/**
 * Serve one attach request per distinct nonce: a re-render with the same
 * request never re-fires, but a fresh nonce (even for the same command) does.
 *
 * A request that names its session exactly is served from what main recorded at
 * the attaching launch, so a repeat click focuses the terminal already showing
 * that session even after a reload or a restart. A keyed request names a crew
 * identity instead, and the hook remembers the terminal it opened for that key
 * within this renderer's lifetime. Requests with neither are one-shot commands
 * and always get a fresh terminal.
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
    const request = attachRequest
    let cancelled = false
    const serve = async (): Promise<void> => {
      const { currentModel, focusSession, launch, resolveAttached } = portsRef.current
      // A failed lookup means main could not say what is attached, not that
      // nothing is: fall back to this renderer's own memory, which is what
      // served the request before main recorded the attach at all. The cost of
      // being wrong here is one extra terminal, never a wrong join.
      // A ticket names a session this renderer was never told, so there is
      // nothing to look up: main resolves it at launch. Focus-or-launch for
      // those requests falls back to the key, as it did before main recorded
      // any attach at all.
      const lookup =
        request.attaches === undefined ||
        isExternalSessionAttachTicketRequest(request.attaches)
          ? undefined
          : request.attaches
      const attachedIds = lookup ? await resolveAttached(lookup).catch(() => []) : []
      if (cancelled) return
      const outcome = resolveTerminalAttach(
        request,
        launchedByKey.current,
        currentModel(),
        attachedIds,
      )
      if (outcome.type === 'focus') {
        focusSession(outcome.id)
        request.onSettled?.(true)
        return
      }
      const launched = launch(request.command, request.attaches)
      if (launched !== undefined && request.key !== undefined) {
        launchedByKey.current.set(request.key, launched)
      }
      request.onSettled?.(launched !== undefined)
    }
    void serve()
    return () => {
      cancelled = true
    }
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
