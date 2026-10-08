import { useEffect, useRef, useState } from 'react'

import {
  hostPathEquals,
  type GasCityAnalyticsConfig,
  type HostPath,
} from '../../../shared'

export function useAnalyticsConfig(
  root: HostPath,
  enabled: boolean,
): GasCityAnalyticsConfig | undefined {
  const [answer, setAnswer] = useState<{
    readonly root: HostPath
    readonly config: GasCityAnalyticsConfig
  }>()
  const asked = useRef<HostPath | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (
      !enabled ||
      (asked.current !== undefined && hostPathEquals(asked.current, root))
    ) {
      return
    }
    asked.current = root
    void window.hvir
      .invoke('gascity:analytics-config', { root })
      .then((config) => {
        if (mounted.current) setAnswer({ root, config })
      })
      .catch((reason: unknown) => {
        if (asked.current !== undefined && hostPathEquals(asked.current, root)) {
          asked.current = undefined
        }
        console.warn(
          '[beads] analytics config unavailable; links hidden until re-asked',
          reason,
        )
      })
  }, [enabled, root])

  return answer !== undefined && hostPathEquals(answer.root, root)
    ? answer.config
    : undefined
}
