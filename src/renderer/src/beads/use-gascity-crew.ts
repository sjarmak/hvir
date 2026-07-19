import { useCallback, useEffect, useRef, useState } from 'react'

import { displayHostPath, type GasCityCrewResponse, type HostPath } from '../../../shared'
import { createVisibilityRefresh } from './beads-refresh'

/**
 * Floor for the crew poll, not the period it settles on.
 *
 * `gc session list` is a live process view and goes stale faster than beads do,
 * which argues for polling often. What it costs argues the other way: about
 * three seconds against a real city over SSH, against tens of milliseconds for
 * `bd`. Polling every four seconds therefore left the reader permanently
 * mid-read. The controller backs the period off from what the read actually
 * takes, so this stays the period on a host where gc is fast and rises on one
 * where it is not — see `beads-refresh.ts`.
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
  /** Which workspace the city probe has already answered for. */
  const probedRoot = useRef<string | undefined>(undefined)
  const rootKey = displayHostPath(root)
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

  // A new workspace answers none of the previous one's questions.
  useEffect(() => {
    setResponse(undefined)
    setHasCity(false)
    probedRoot.current = undefined
  }, [root, connected])

  // Probe once per workspace, and only once the section is actually on screen.
  // The panel stays mounted behind the Files and Git tabs, so an ungated probe
  // walked up to a dozen directory levels on every workspace switch for a
  // section the user may never open. A workspace outside a Gas City never
  // invokes `gc` at all, so the section costs nothing where it does not apply.
  // The answer holds for as long as the workspace does, so closing and
  // reopening the section must not ask again.
  useEffect(() => {
    if (!connected || hidden || probedRoot.current === rootKey) return
    probedRoot.current = rootKey
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
  }, [root, rootKey, connected, hidden])

  useEffect(() => {
    if (!hasCity) return
    const controller = createVisibilityRefresh({
      onRefresh: () => refresh(false),
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
