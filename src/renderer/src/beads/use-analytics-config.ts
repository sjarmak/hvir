import { useEffect, useRef, useState } from 'react'

import type { GasCityAnalyticsConfig } from '../../../shared'

/**
 * Where the observability links point, read once from the main process the
 * first time the section is on screen. The environment does not change while
 * the app runs, so there is nothing to poll, and an answer that arrives after
 * the section is hidden again is kept for when it returns. A failed read leaves
 * the config undefined and no link renders: the panel degrades to what it
 * showed before these links existed, silently, the same way the crew probe does.
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
      .catch(() => undefined)
  }, [enabled])

  return config
}
