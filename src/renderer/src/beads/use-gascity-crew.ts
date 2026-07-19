import { useCallback, useEffect, useRef, useState } from 'react'

import type { GasCityCrewResponse, HostPath } from '../../../shared'
import { createVisibilityRefresh } from './beads-refresh'

/**
 * `gc session list` is a live process view, so it goes stale far faster than
 * beads do; poll a little more often than the bead snapshot, but only while the
 * panel is visible.
 */
const VISIBLE_POLL_INTERVAL_MS = 4000

export interface GasCityCrewOptions {
  readonly root: HostPath
  readonly connected: boolean
  readonly hidden: boolean
  readonly includeInternals: boolean
}

export interface GasCityCrewState {
  /** Undefined until the first crew fetch resolves; absent for non-city workspaces. */
  readonly response: GasCityCrewResponse | undefined
  readonly loading: boolean
  /** Re-read sessions and, unlike the poll, the city's cached shape too. */
  readonly refresh: () => void
}

/**
 * Owns the crew data for one workspace: the one-shot city probe that decides
 * whether `gc` is worth invoking at all, and the visible-only poll that keeps
 * the crew current afterwards. Mirrors the beads panel's refresh policy so the
 * two sections behave identically when the panel is backgrounded.
 */
export function useGasCityCrew(options: GasCityCrewOptions): GasCityCrewState {
  const { root, connected, hidden, includeInternals } = options
  const [hasCity, setHasCity] = useState(false)
  const [response, setResponse] = useState<GasCityCrewResponse>()
  const [loading, setLoading] = useState(false)
  const inFlight = useRef(false)
  const requestSerial = useRef(0)
  const includeInternalsRef = useRef(includeInternals)
  includeInternalsRef.current = includeInternals

  const refresh = useCallback(async (force: boolean): Promise<void> => {
    // Non-reentrant for the same reason the bead refresh is: a slow `gc` call
    // over SSH can outlast the poll interval, and overlapping them would only
    // multiply the work.
    if (inFlight.current) return
    inFlight.current = true
    const serial = ++requestSerial.current
    setLoading(true)
    try {
      const result = await window.hvir.invoke('gascity:crew', {
        root,
        includeInternals: includeInternalsRef.current,
        ...(force ? { refresh: true } : {}),
      })
      if (serial !== requestSerial.current) return
      setResponse(result)
    } catch (reason) {
      if (serial !== requestSerial.current) return
      setResponse({
        available: false,
        reason: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      })
    } finally {
      inFlight.current = false
      if (serial === requestSerial.current) setLoading(false)
    }
  }, [root])

  // Probe once per workspace. A workspace outside a Gas City never invokes `gc`
  // at all, so the crew section costs nothing where it does not apply.
  useEffect(() => {
    setResponse(undefined)
    if (!connected) {
      setHasCity(false)
      return
    }
    let cancelled = false
    void window.hvir
      .invoke('gascity:probe', { root })
      .then((result) => {
        if (!cancelled) setHasCity(result.hasCity)
      })
      .catch(() => {
        if (!cancelled) setHasCity(false)
      })
    return () => {
      cancelled = true
    }
  }, [root, connected])

  useEffect(() => {
    if (!hasCity) return
    const controller = createVisibilityRefresh({
      onRefresh: () => void refresh(false),
      intervalMs: VISIBLE_POLL_INTERVAL_MS,
    })
    controller.setVisible(connected && !hidden)
    const onFocus = (): void => controller.focus()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      controller.dispose()
    }
  }, [hasCity, connected, hidden, refresh])

  // A toggled internals filter changes the request, not just the rendering.
  useEffect(() => {
    if (hasCity && connected) void refresh(false)
  }, [includeInternals, hasCity, connected, refresh])

  return { response, loading, refresh: () => void refresh(true) }
}
