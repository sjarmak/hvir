import {
  ARCHITECTURE_DEFAULT_LAYOUT,
  ARCHITECTURE_LAYOUT_FILE,
  ArchitectureLayoutError,
  parseArchitectureLayout,
  type ArchitectureLayout,
} from '../../shared/architecture-layout'
import type { ArchitectureSource } from '../../shared/architecture-review'
import type { CaptureEntry } from './capture-entries'

export interface CapturedLayout {
  readonly layout: ArchitectureLayout
  /** The layout file's pinned bytes; absent when the Current end has none. */
  readonly file?: ArchitectureSource
}

/**
 * The Current end's layout file governs both ends, so a comparison never regroups modules
 * only because the mapping changed between them. An invalid file refuses the scan and names
 * the field; it never falls back to the defaults.
 */
export async function readCaptureLayout(
  entries: readonly CaptureEntry[],
  endLabel: string,
  read: (entry: CaptureEntry) => Promise<ArchitectureSource>,
): Promise<CapturedLayout> {
  const entry = entries.find((candidate) => candidate.path === ARCHITECTURE_LAYOUT_FILE)
  if (!entry) return { layout: ARCHITECTURE_DEFAULT_LAYOUT }
  if (entry.mode && entry.mode !== '100644' && entry.mode !== '100755')
    throw new Error(
      `Unsupported symbolic link or submodule in scan: ${ARCHITECTURE_LAYOUT_FILE}`,
    )
  const file = await read(entry)
  try {
    return { layout: parseArchitectureLayout(file.content), file }
  } catch (error) {
    if (!(error instanceof ArchitectureLayoutError)) throw error
    throw new Error(
      `Invalid ${ARCHITECTURE_LAYOUT_FILE} at ${endLabel}: ${error.message}`,
      { cause: error },
    )
  }
}
