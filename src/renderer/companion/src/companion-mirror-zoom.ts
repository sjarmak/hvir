/**
 * How the desktop's grid is scaled onto the phone (ADR-050): the emulator
 * keeps the desktop's exact columns and rows, and only a CSS transform
 * changes. Fill-height, the default, makes the rows fill the terminal area
 * and lets the person pan across the columns (a wide desktop grid fitted to a
 * phone's width is a few pixels per row over a dark area); fit-to-width shows
 * the whole grid. The choice is the page's own and is remembered in its
 * storage.
 */
export type CompanionMirrorZoom = 'fit-width' | 'fill-height'

export const COMPANION_MIRROR_ZOOM_STORAGE_KEY = 'hvir-companion-mirror-zoom'
export const DEFAULT_MIRROR_ZOOM: CompanionMirrorZoom = 'fill-height'

const ZOOMS: readonly CompanionMirrorZoom[] = ['fit-width', 'fill-height']

export function isCompanionMirrorZoom(value: unknown): value is CompanionMirrorZoom {
  return typeof value === 'string' && (ZOOMS as readonly string[]).includes(value)
}

export function nextMirrorZoom(zoom: CompanionMirrorZoom): CompanionMirrorZoom {
  return zoom === 'fit-width' ? 'fill-height' : 'fit-width'
}

/** The toggle's label: the mode a tap switches to. */
export function mirrorZoomAction(zoom: CompanionMirrorZoom): string {
  return zoom === 'fit-width' ? 'Fill height' : 'Fit width'
}

export interface MirrorGeometry {
  /** The terminal area, in CSS pixels. */
  readonly hostWidth: number
  readonly hostHeight: number
  /** The emulator's grid at scale 1, in CSS pixels. */
  readonly gridWidth: number
  readonly gridHeight: number
}

/**
 * The transform scale for a zoom, or nothing while either box has no layout.
 * Fit-to-width never enlarges and never lets the rows run past the area;
 * fill-height sets the rows to the area's height whatever the width becomes.
 */
export function mirrorScale(
  zoom: CompanionMirrorZoom,
  geometry: MirrorGeometry,
): number | undefined {
  const { hostWidth, hostHeight, gridWidth, gridHeight } = geometry
  if (hostWidth <= 0 || hostHeight <= 0 || gridWidth <= 0 || gridHeight <= 0) {
    return undefined
  }
  return zoom === 'fill-height'
    ? hostHeight / gridHeight
    : Math.min(1, hostWidth / gridWidth, hostHeight / gridHeight)
}

/** Storage can be absent or refuse (private browsing): the default stands in. */
export function readMirrorZoom(storage: () => Storage): CompanionMirrorZoom {
  try {
    const stored = storage().getItem(COMPANION_MIRROR_ZOOM_STORAGE_KEY)
    return isCompanionMirrorZoom(stored) ? stored : DEFAULT_MIRROR_ZOOM
  } catch {
    return DEFAULT_MIRROR_ZOOM
  }
}

/** A refused write loses only the memory of the choice, never the choice itself. */
export function writeMirrorZoom(storage: () => Storage, zoom: CompanionMirrorZoom): void {
  try {
    storage().setItem(COMPANION_MIRROR_ZOOM_STORAGE_KEY, zoom)
  } catch {
    return
  }
}
