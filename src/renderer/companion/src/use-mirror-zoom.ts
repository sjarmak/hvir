/**
 * The page's zoom choice for its mirrors: read from the page's storage once,
 * toggled by the header control, written back on every change.
 */
import { useCallback, useEffect, useState } from 'react'

import {
  nextMirrorZoom,
  readMirrorZoom,
  writeMirrorZoom,
  type CompanionMirrorZoom,
} from './companion-mirror-zoom'

const pageStorage = (): Storage => localStorage

export interface CompanionMirrorZoomControl {
  readonly zoom: CompanionMirrorZoom
  readonly toggle: () => void
}

export function useMirrorZoom(): CompanionMirrorZoomControl {
  const [zoom, setZoom] = useState(() => readMirrorZoom(pageStorage))
  useEffect(() => {
    writeMirrorZoom(pageStorage, zoom)
  }, [zoom])
  const toggle = useCallback(() => setZoom(nextMirrorZoom), [])
  return { zoom, toggle }
}
