/**
 * The phone's mirror text size (ADR-059). The grid the page holds the PTY at
 * is its area divided by one cell (ADR-058), so the font is the one number
 * that decides how much of a session a phone shows: at a desktop-readable
 * size a phone holds a session at forty columns, which is neither the density
 * the desktop has nor the history the height could carry.
 *
 * The size is the person's rather than a constant, because how small is
 * readable is a property of the eyes and the device and not of the code, and
 * it is remembered on the device so the choice is made once. The ladder is
 * whole pixels: the emulator measures its own cell, and steps finer than a
 * pixel move the derived grid by less than a column.
 */

/** The steps the control walks, smallest first; every value is a whole pixel. */
export const COMPANION_TEXT_SIZES: readonly number[] = [7, 8, 9, 10, 11, 12, 13, 15]

/**
 * Where a phone starts: a little over half the desktop-readable 15px, which on
 * a phone's width is about sixty columns rather than about forty.
 */
export const COMPANION_DEFAULT_TEXT_SIZE = 10

const STORAGE_KEY = 'hvir.companion.textSize'

/** The stored size, or the default whenever nothing usable is stored. */
export function readCompanionTextSize(storage: Pick<Storage, 'getItem'>): number {
  try {
    return nearestTextSize(Number(storage.getItem(STORAGE_KEY)))
  } catch {
    // A phone browsing privately throws on storage rather than answering.
    return COMPANION_DEFAULT_TEXT_SIZE
  }
}

/** Remembers the size for the next visit; a storage that refuses is not an error here. */
export function writeCompanionTextSize(
  storage: Pick<Storage, 'setItem'>,
  size: number,
): void {
  try {
    storage.setItem(STORAGE_KEY, String(nearestTextSize(size)))
  } catch {
    // Nothing to recover: the mirror still draws at the size just chosen.
  }
}

/** The step one place along the ladder, or the size itself at either end. */
export function stepCompanionTextSize(size: number, direction: 1 | -1): number {
  const index = COMPANION_TEXT_SIZES.indexOf(nearestTextSize(size))
  const next = index + direction
  return (
    COMPANION_TEXT_SIZES[next] ??
    COMPANION_TEXT_SIZES[index] ??
    COMPANION_DEFAULT_TEXT_SIZE
  )
}

/** The ladder step closest to a number, and the default for anything that is not one. */
export function nearestTextSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return COMPANION_DEFAULT_TEXT_SIZE
  return COMPANION_TEXT_SIZES.reduce(
    (closest, step) =>
      Math.abs(step - size) < Math.abs(closest - size) ? step : closest,
    COMPANION_DEFAULT_TEXT_SIZE,
  )
}
