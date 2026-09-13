import { useEffect, useRef, useState } from 'react'

import type { GasCityAnalyticsConfig } from '../../../shared'

/**
 * Where the observability links point, read once from the main process the
 * first time the section is on screen. The environment does not change while
 * the app runs, so there is nothing to poll, and an answer that arrives after
 * the section is hidden again is kept for when it returns. A failed read leaves
 * the config undefined and no link renders, is logged once, and is asked again
 * the next time the section is enabled, so one transient bridge failure does
 * not hide the links for the rest of the app session.
 */
export function useAnalyticsConfig(enabled: boolean): GasCityAnalyticsConfig | undefined {
  const [config, setConfig] = useState<GasCityAnalyticsConfig>()
  const asked = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled || asked.current) return
    asked.current = true
    void window.hvir
      .invoke('gascity:analytics-config', {})
      .then((result) => {
        if (mounted.current) setConfig(result)
      })
      .catch((reason: unknown) => {
        asked.current = false
        console.warn('[beads] analytics config unavailable; links hidden until re-asked', reason)
      })
  }, [enabled])

  return config
}
