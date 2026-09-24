import { ARCHITECTURE_SCOPE as SCOPE } from '../../shared/architecture-review'

export interface CaptureEntry {
  readonly path: string
  readonly object?: string
  readonly mode?: string
}

export function parseIndex(output: string): readonly CaptureEntry[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t')
      const [mode, object, stage] = record.slice(0, tab).split(' ')
      if (tab < 0 || stage !== '0')
        throw new Error('Resolve index conflicts before architecture review')
      return { path: record.slice(tab + 1), object, mode }
    })
}

export function parseTree(output: string): readonly CaptureEntry[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t')
      const [mode, , object] = record.slice(0, tab).split(' ')
      if (tab < 0 || !object) throw new Error('Invalid Git tree entry')
      return { path: record.slice(tab + 1), object, mode }
    })
}

export function parsePaths(output: string): readonly CaptureEntry[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ path }))
}

/** Unique in-scope entries in path order, each checked before any byte is read. */
export function selectEntries(entries: readonly CaptureEntry[]): readonly CaptureEntry[] {
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()]
    .filter((entry) => included(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path))
  if (unique.length > SCOPE.maxFiles)
    throw new Error(
      `Architecture scan exceeds ${SCOPE.maxFiles} files; narrow the workspace`,
    )
  for (const entry of unique) {
    assertRelative(entry.path)
    if (entry.mode && entry.mode !== '100644' && entry.mode !== '100755')
      throw new Error(`Unsupported symbolic link or submodule in scan: ${entry.path}`)
  }
  return unique
}

export function isSource(path: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path)
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

function included(path: string): boolean {
  return (
    !path
      .split('/')
      .some((part) => (SCOPE.excludedDirectories as readonly string[]).includes(part)) &&
    (isSource(path) ||
      /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig\.json|package\.json)$/.test(path))
  )
}
