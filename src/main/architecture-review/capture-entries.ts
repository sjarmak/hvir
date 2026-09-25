import {
  ARCHITECTURE_DEFAULT_LAYOUT,
  ARCHITECTURE_LAYOUT_FILE,
  inLayoutScope,
  type ArchitectureLayout,
} from '../../shared/architecture-layout'
import { ARCHITECTURE_SCOPE as SCOPE } from '../../shared/architecture-review'

export interface CaptureEntry {
  readonly path: string
  readonly object?: string
  readonly mode?: string
  /** Blob size from `git ls-tree -l`; the live listing carries none. */
  readonly size?: number
}

/** `git ls-tree -r [-l] -z` records: mode, type, object, the padded size with -l, then path. */
const TREE_RECORD = /^(\d{6}) (\w+) ([0-9a-f]{40,64})(?: +(-|\d+))?\t/

export function parseTree(output: string): readonly CaptureEntry[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = TREE_RECORD.exec(record)
      if (!match) throw new Error('Invalid Git tree entry')
      const [header, mode, , object, size] = match
      const path = record.slice(header.length)
      return size === undefined || size === '-'
        ? { path, object, mode }
        : { path, object, mode, size: Number(size) }
    })
}

/**
 * `git ls-files -t` over cached, deleted and other files: the paths on disk now. A deleted
 * tracked file is listed twice, once cached and once tagged R; a skip-worktree file (S) is
 * one Git does not read from the working tree. Neither is part of the live side.
 */
export function parseLivePaths(output: string): readonly CaptureEntry[] {
  const records = output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      if (record[1] !== ' ') throw new Error('Invalid Git file listing entry')
      return { tag: record[0], path: record.slice(2) }
    })
  const absent = new Set(
    records
      .filter((record) => record.tag === 'R' || record.tag === 'S')
      .map((r) => r.path),
  )
  return records
    .filter((record) => !absent.has(record.path))
    .map(({ path }) => ({ path }))
}

/**
 * Unique in-scope entries in path order, each checked before any byte is read. The layout's
 * scope narrows sources only: a config outside it may still configure resolution inside it.
 * The size cap is the caller's to enforce on the whole selection; nothing here drops files.
 */
export function selectEntries(
  entries: readonly CaptureEntry[],
  layout: ArchitectureLayout = ARCHITECTURE_DEFAULT_LAYOUT,
): readonly CaptureEntry[] {
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()]
    .filter((entry) => inArchitectureScope(entry.path))
    .filter((entry) => !isSource(entry.path) || inLayoutScope(layout, entry.path))
    .sort((a, b) => a.path.localeCompare(b.path))
  for (const entry of unique) {
    assertRelative(entry.path)
    if (entry.mode && entry.mode !== '100644' && entry.mode !== '100755')
      throw new Error(`Unsupported symbolic link or submodule in scan: ${entry.path}`)
  }
  return unique
}

const extensions: ReadonlySet<string> = new Set(SCOPE.extensions)

/** A file some language scanner reads; declaration files describe code, they are not code. */
export function isSource(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && extensions.has(name.slice(dot + 1)) && !/\.d\.[cm]?ts$/.test(name)
}

function assertRelative(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '..' || part === '.') ||
    path.includes('\0')
  )
    throw new Error('Invalid repository source path')
}

/** Sources and the configs that resolve them, outside the excluded directories. */
export function inArchitectureScope(path: string): boolean {
  return (
    !path
      .split('/')
      .some((part) => (SCOPE.excludedDirectories as readonly string[]).includes(part)) &&
    (isSource(path) ||
      /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig\.json|package\.json|go\.mod|Cargo\.toml)$/.test(path))
  )
}

/** Every path whose bytes a capture may read: sources, configs and the layout file. */
export function affectsArchitectureCapture(path: string): boolean {
  return path === ARCHITECTURE_LAYOUT_FILE || inArchitectureScope(path)
}
