import { useEffect, useRef } from 'react'

import type { TerminalAttachRequest } from './terminal-workspace-model'

/**
 * Fire `launch(command)` once per distinct attach-request nonce: a re-render
 * with the same request never re-launches, but a fresh nonce (even for the same
 * command) does. The caller's `launch` is responsible for its own readiness
 * guard — the nonce bookkeeping is all this hook owns.
 */
export function useTerminalAttachRequest(
  attachRequest: TerminalAttachRequest | undefined,
  launch: (command: string) => void,
): void {
  const lastNonce = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!attachRequest || lastNonce.current === attachRequest.nonce) return
    lastNonce.current = attachRequest.nonce
    launch(attachRequest.command)
    // `launch` is stable enough for this one-shot; the nonce guard gates re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachRequest])
}
