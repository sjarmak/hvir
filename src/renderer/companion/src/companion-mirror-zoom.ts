/**
 * How the desktop's grid is shown on the phone (ADR-050): the emulator keeps
 * the desktop's exact columns and rows whatever the view. Reflow, the
 * default, reads the emulator's screen and scrollback as text wrapped to the
 * phone's width at a readable size, filling the area and scrolling like a
 * page. The two grid views only change a CSS transform: fit-to-width shows
 * the whole grid (a wide desktop grid on a phone is small), and fill-height
 * makes the rows fill the area and lets the person pan across the columns.
 * The choice is the page's own and is remembered in its storage.
 */
export type CompanionMirrorGridZoom = 'fit-width' | 'fill-height'
export type CompanionMirrorZoom = 'reflow' | CompanionMirrorGridZoom

export const COMPANION_MIRROR_ZOOM_STORAGE_KEY = 'hvir-companion-mirror-zoom'
export const DEFAULT_MIRROR_ZOOM: CompanionMirrorZoom = 'reflow'

/** A tap moves through the views in this order and round again. */
const ZOOMS: readonly CompanionMirrorZoom[] = ['reflow', 'fit-width', 'fill-height']

const LABELS: Record<CompanionMirrorZoom, string> = {
  reflow: 'Reflow',
  'fit-width': 'Fit width',
  'fill-height': 'Fill height',
}

export function isCompanionMirrorZoom(value: unknown): value is CompanionMirrorZoom {
  return typeof value === 'string' && (ZOOMS as readonly string[]).includes(value)
}

export function nextMirrorZoom(zoom: CompanionMirrorZoom): CompanionMirrorZoom {
  return ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length]!
}

/** The view's name, as the header control shows the one in force. */
export function mirrorZoomLabel(zoom: CompanionMirrorZoom): string {
  return LABELS[zoom]
}

/** What a tap on the control does, for its accessible name. */
export function mirrorZoomAction(zoom: CompanionMirrorZoom): string {
  return `View: ${LABELS[zoom]}. Switch to ${LABELS[nextMirrorZoom(zoom)]}`
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
 * The transform scale for a grid view, or nothing while either box has no
 * layout. Fit-to-width sets the columns to the area's width and never
 * enlarges; the scrollback drawn above the grid takes the height the grid
 * leaves, and the area scrolls over the two. Fill-height sets the rows to the
 * area's height whatever the width becomes.
 */
export function mirrorScale(
  zoom: CompanionMirrorGridZoom,
  geometry: MirrorGeometry,
): number | undefined {
  const { hostWidth, hostHeight, gridWidth, gridHeight } = geometry
  if (hostWidth <= 0 || hostHeight <= 0 || gridWidth <= 0 || gridHeight <= 0) {
    return undefined
  }
  return zoom === 'fill-height'
    ? hostHeight / gridHeight
    : Math.min(1, hostWidth / gridWidth)
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
