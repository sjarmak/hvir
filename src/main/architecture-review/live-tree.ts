import type { ExecResult, HostPath } from '../../shared'
import { ARCHITECTURE_SCOPE as SCOPE } from '../../shared/architecture-review'
import type { ExecOptions } from '../project-host/project-host'
import { gitBlobId, objectFormat } from './blob-id'
import { readTarEntries, TarFramingError, type TarEntry } from './tar-archive'

export type LiveExec = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>

export interface LiveFile {
  readonly path: string
  readonly content: string
  /** Git's blob id for exactly these bytes. */
  readonly object: string
}

const TIMEOUT = 60_000
const SYMLINK_EXIT = 64
const HASH_EXIT = 65
const OVER_CAP_EXIT = 66

/** The live side is larger than the byte cap; the host measured it and sent no content. */
export class LiveTreeOverCapError extends Error {
  constructor(readonly bytes: number) {
    super(`Live sources total ${bytes} bytes, above the architecture scan cap`)
  }
}
export const SOURCES_CHANGED =
  'Sources changed during capture; refresh architecture review'

/**
 * One host command reads the whole live side (ADR-063). Directories holding a source are
 * refused when they are symbolic links, so no read leaves the workspace. Git hashes every
 * file, tar streams them, and Git hashes them again: bytes that match both hash passes were
 * on disk, unchanged, across the whole read. That is the consistency check the old second
 * full read performed, for the cost of one object id per file instead of every byte again.
 * Git resolves --stdin-paths from the repository root, so a workspace below it prefixes them.
 * The sizes are summed first, from metadata, so a side above the cap ($1 bytes) is refused
 * with its measured size before any content crosses the host boundary. No source is named
 * "total", which is how wc labels its sum lines.
 */
const SCRIPT = `
max=$1
while IFS= read -r directory && [ -n "$directory" ]; do
  if [ -L "$directory" ]; then printf '%s\\n' "$directory" >&2; exit ${SYMLINK_EXIT}; fi
done
paths=$(cat)
bytes=$(printf '%s\\n' "$paths" | tr '\\n' '\\0' | xargs -0 wc -c -- |
  awk '{ n = $1; sub(/^ *[0-9]+ /, ""); if ($0 != "total") s += n } END { print s + 0 }')
if [ "$bytes" -gt "$max" ]; then printf '%s\\n' "$bytes" >&2; exit ${OVER_CAP_EXIT}; fi
prefix=$(git rev-parse --show-prefix) || exit ${HASH_EXIT}
objects() {
  printf '%s\\n' "$paths" | while IFS= read -r path; do printf '%s%s\\n' "$prefix" "$path"; done |
    git hash-object --no-filters --stdin-paths || exit ${HASH_EXIT}
}
objects
printf '%s\\n' "$paths" | tr '\\n' '\\0' | xargs -0 tar -cf - --
archived=$?
objects
exit "$archived"
`

/** Reads `paths` (relative to `root`, in scan order) from the live tree in one host call. */
export async function readLiveTree(
  exec: LiveExec,
  root: HostPath,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, LiveFile>> {
  if (paths.length === 0) return new Map()
  for (const path of paths)
    // Git's --stdin-paths reads one path per line and unquotes a leading double quote.
    if (path.includes('\n') || path.startsWith('"'))
      throw new Error(`Unsupported source path in scan: ${JSON.stringify(path)}`)
  const result = await exec(
    'sh',
    ['-c', SCRIPT, 'hvir-architecture-live-read', String(SCOPE.maxTotalBytes)],
    {
      cwd: root,
      input: scriptInput(paths),
      signal,
      timeout: TIMEOUT,
      maxBuffer: SCOPE.maxTotalBytes + paths.length * 4 * 1024 + 1024 * 1024,
      env: { GIT_OPTIONAL_LOCKS: '0', COPYFILE_DISABLE: '1' },
    },
  )
  if (result.code === OVER_CAP_EXIT) throw overCap(result)
  if (result.code === SYMLINK_EXIT)
    throw new Error(`Unsupported symbolic link in scan: ${result.stderr.trim()}`)
  if (result.code === HASH_EXIT) throw failed(result)
  const sections = splitSections(Buffer.from(result.stdout, 'utf8'), paths.length)
  if (sections?.before.some((id, index) => id !== sections.after[index]))
    throw new Error(SOURCES_CHANGED)
  if (result.code !== 0) throw failed(result)
  if (!sections) throw new Error('Malformed architecture live read output')
  return verifiedFiles(readArchive(sections.archive, paths), paths, sections.after)
}

/** Directories first, one per line, then a blank line, then the paths. */
function scriptInput(paths: readonly string[]): string {
  const directories = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth += 1)
      directories.add(parts.slice(0, depth).join('/'))
  }
  return [...directories, '', ...paths].map((line) => `${line}\n`).join('')
}

function overCap(result: ExecResult): Error {
  const bytes = Number(result.stderr.trim())
  if (!Number.isSafeInteger(bytes)) return failed(result)
  return new LiveTreeOverCapError(bytes)
}

function failed(result: ExecResult): Error {
  const detail = result.stderr.trim() || `exit ${result.code ?? result.signal}`
  return new Error(`Architecture live read failed: ${detail}`)
}

interface Sections {
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly archive: Buffer
}

/** Object ids before, the archive, then object ids after; undefined when not framed so. */
function splitSections(output: Buffer, count: number): Sections | undefined {
  const width = output.indexOf(10)
  if (width !== 40 && width !== 64) return undefined
  const idBytes = count * (width + 1)
  if (output.length < idBytes * 2) return undefined
  const ids = (bytes: Buffer) => {
    const lines = bytes.toString('latin1').split('\n').slice(0, -1)
    return lines.length === count && lines.every((line) => HEX[width]!.test(line))
      ? lines
      : undefined
  }
  const before = ids(output.subarray(0, idBytes))
  const after = ids(output.subarray(output.length - idBytes))
  if (!before || !after) return undefined
  return { before, after, archive: output.subarray(idBytes, output.length - idBytes) }
}
const HEX: Record<number, RegExp> = { 40: /^[0-9a-f]{40}$/, 64: /^[0-9a-f]{64}$/ }

/**
 * Host output arrives as UTF-8 text. A source that is not valid UTF-8 changes length when
 * decoded, which breaks the archive framing right after it: the last whole entry names it.
 */
function readArchive(archive: Buffer, paths: readonly string[]): readonly TarEntry[] {
  try {
    return readTarEntries(archive)
  } catch (error) {
    if (!(error instanceof TarFramingError) || error.complete === 0) throw error
    throw new Error(`Unsupported large or invalid source: ${paths[error.complete - 1]}`, {
      cause: error,
    })
  }
}

function verifiedFiles(
  entries: readonly TarEntry[],
  paths: readonly string[],
  objects: readonly string[],
): ReadonlyMap<string, LiveFile> {
  if (entries.length !== paths.length)
    throw new Error('Architecture live read returned a different file set')
  const files = new Map<string, LiveFile>()
  let bytes = 0
  entries.forEach((entry, index) => {
    const path = paths[index]!
    const object = objects[index]!
    if (entry.name !== path)
      throw new Error('Architecture live read returned a different file set')
    if (entry.type !== 'file')
      throw new Error(`Unsupported symbolic link or non-file source: ${path}`)
    if (
      entry.content.length > SCOPE.maxFileBytes ||
      gitBlobId(entry.content, objectFormat(object)) !== object
    )
      throw new Error(`Unsupported large or invalid source: ${path}`)
    bytes += entry.content.length
    if (bytes > SCOPE.maxTotalBytes)
      throw new Error('Architecture scan exceeds the total source byte limit')
    files.set(path, { path, content: entry.content.toString('utf8'), object })
  })
  return files
}
