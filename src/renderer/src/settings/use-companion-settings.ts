import { useCallback, useEffect, useRef, useState } from 'react'

import type { CompanionConfigSave, CompanionConfigView } from '../../../shared'

export interface CompanionSettingsState {
  /** Undefined until the first read answers. */
  readonly view: CompanionConfigView | undefined
  readonly error: string | undefined
  readonly busy: boolean
  readonly save: (request: CompanionConfigSave) => Promise<void>
  readonly issuePairing: () => Promise<void>
  readonly revokePairing: () => Promise<void>
}

/**
 * The Companion view as the main process holds it: read once when the section
 * mounts, then followed through `companion:status-changed`. Every action
 * answers with the next view, so the section never guesses at the outcome,
 * and a failed action leaves the last view in place with its message shown.
 */
export function useCompanionSettings(): CompanionSettingsState {
  const [view, setView] = useState<CompanionConfigView>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.hvir.on('companion:status-changed', (next) => {
      if (mounted.current) setView(next)
    })
    void window.hvir
      .invoke('companion:config', undefined)
      .then((next) => {
        if (mounted.current) setView(next)
      })
      .catch((reason: unknown) => {
        if (mounted.current) setError(messageOf(reason))
      })
    return () => {
      mounted.current = false
      void unsubscribe()
    }
  }, [])

  const run = useCallback(async (action: () => Promise<CompanionConfigView>) => {
    setBusy(true)
    try {
      const next = await action()
      if (!mounted.current) return
      setView(next)
      setError(undefined)
    } catch (reason: unknown) {
      if (mounted.current) setError(messageOf(reason))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])

  return {
    view,
    error,
    busy,
    save: useCallback(
      (request) => run(() => window.hvir.invoke('companion:config-save', request)),
      [run],
    ),
    issuePairing: useCallback(
      () => run(() => window.hvir.invoke('companion:pairing-issue', undefined)),
      [run],
    ),
    revokePairing: useCallback(
      () => run(() => window.hvir.invoke('companion:pairing-revoke', undefined)),
      [run],
    ),
  }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
