import { createHash } from 'node:crypto'
import type { HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { affectsArchitectureCapture } from './capture-entries'
import type { ArchitectureScanRecorder } from './scan-recorder'

const TIMEOUT = 30_000
const MAX_OUTPUT = 4 * 1024 * 1024
const ENV = { GIT_OPTIONAL_LOCKS: '0' }

/**
 * HEAD, the workspace prefix, the tagged staged entries and the porcelain status, in one
 * host command. Every -z record is non-empty, so an empty record marks the end of a
 * section. The -v tag is lowercase for an assume-unchanged entry, which status never
 * reports although a capture reads its working-tree bytes.
 */
const SCRIPT = `
set -e
head=$(git rev-parse --verify HEAD)
prefix=$(git rev-parse --show-prefix)
printf 'h%s\\0p%s\\0\\0' "$head" "$prefix"
git ls-files --stage -v -z -- .
printf '\\0'
git status --porcelain=v1 -z --untracked-files=all --no-renames -- .
printf '\\0'
`

/**
 * One existence flag per path read from stdin, then the blob id of each present path.
 * Paths are relative to the repository root, so the check runs from there as
 * `git hash-object --stdin-paths` does. A conflicted or assume-unchanged path may be gone.
 */
const HASH_SCRIPT = `
set -e
cd "$(git rev-parse --show-toplevel)"
nl='
'
present=''
while IFS= read -r path; do
  if [ -f "$path" ] || [ -L "$path" ]; then
    printf '1\\n'
    present="$present$path$nl"
  else
    printf '0\\n'
  fi
done
printf '\\0'
if [ -n "$present" ]; then
  printf '%s' "$present" | git hash-object --no-filters --stdin-paths
fi
`

interface StatusEntry {
  readonly code: string
  /** Relative to the repository root, as `git hash-object --stdin-paths` resolves it. */
  readonly repositoryPath: string
}

/**
 * A digest of everything a live Current end is read from: HEAD
 * identity, the in-scope staged entries, the in-scope porcelain status and the blob id of
 * every in-scope file that differs from the index. Equal digests mean a fresh capture
 * would read the same bytes, so freshness never needs a recapture.
 */
export async function readArchitectureLiveState(
  host: ProjectHost,
  root: HostPath,
  signal: AbortSignal,
  recorder?: ArchitectureScanRecorder,
): Promise<string> {
  if (root.hostId !== host.hostId) throw new Error('Invalid architecture workspace')
  const exec = checkedExec(host, root, signal, recorder)
  const state = parseState(await exec('sh', ['-c', SCRIPT, 'hvir-architecture-state']))
  const objects = await worktreeObjects(exec, [
    ...new Set([...state.status.map((entry) => entry.repositoryPath), ...state.hidden]),
  ])
  return createHash('sha256')
    .update(JSON.stringify({ ...state, objects }))
    .digest('hex')
}

/** HEAD, the workspace prefix and whether the in-scope live tree equals HEAD. */
export interface ArchitectureLiveBase {
  readonly head: string
  /** The workspace's path below the repository root, '' at the root. */
  readonly prefix: string
  /** No in-scope staged, unstaged, untracked or assume-unchanged difference. */
  readonly clean: boolean
}

/**
 * The commit a handoff worktree starts from when Current is the live tree. Only a clean
 * in-scope tree equals HEAD, so only then is HEAD the original Current end.
 */
export async function readArchitectureLiveBase(
  host: ProjectHost,
  root: HostPath,
  signal: AbortSignal,
): Promise<ArchitectureLiveBase> {
  if (root.hostId !== host.hostId) throw new Error('Invalid architecture workspace')
  const exec = checkedExec(host, root, signal, undefined)
  const state = parseState(await exec('sh', ['-c', SCRIPT, 'hvir-architecture-state']))
  return {
    head: state.head,
    prefix: state.prefix,
    clean: state.status.length === 0 && state.hidden.length === 0,
  }
}

type CheckedExec = (
  command: string,
  args: readonly string[],
  input?: string,
) => Promise<string>

function checkedExec(
  host: ProjectHost,
  root: HostPath,
  signal: AbortSignal,
  recorder: ArchitectureScanRecorder | undefined,
): CheckedExec {
  return (command, args, input) =>
    measured(recorder, async () => {
      recorder?.countHostCall()
      const result = await host.exec(command, args, {
        cwd: root,
        input,
        signal,
        timeout: TIMEOUT,
        maxBuffer: MAX_OUTPUT,
        env: ENV,
      })
      if (result.code !== 0 || result.outputTruncated) {
        const detail = result.stderr.trim() || `exit ${result.code ?? result.signal}`
        throw new Error(`Architecture freshness check failed: ${detail}`)
      }
      return result.stdout
    })
}

/** Blob id, or null when absent, of each working-tree path; none when there are none. */
async function worktreeObjects(
  exec: CheckedExec,
  paths: readonly string[],
): Promise<readonly (string | null)[]> {
  if (paths.length === 0) return []
  const output = await exec(
    'sh',
    ['-c', HASH_SCRIPT, 'hvir-architecture-objects'],
    stdinPaths(paths),
  )
  const [flagText = '', objectText = '', ...rest] = output.split('\0')
  const flags = flagText.split('\n').filter(Boolean)
  const objects = objectText.split('\n').filter(Boolean)
  if (
    rest.length !== 0 ||
    flags.length !== paths.length ||
    flags.some((flag) => flag !== '0' && flag !== '1') ||
    objects.length !== flags.filter((flag) => flag === '1').length
  )
    throw new Error('Architecture freshness check returned a different file set')
  let next = 0
  return flags.map((flag) => (flag === '1' ? objects[next++]! : null))
}

/** A scan's state read is a listing like any other and is credited to its recorder. */
function measured(
  recorder: ArchitectureScanRecorder | undefined,
  work: () => Promise<string>,
): Promise<string> {
  return recorder
    ? recorder.measure('listing', work, (output) => ({
        bytes: Buffer.byteLength(output),
        items: output.split(/[\0\n]/).filter(Boolean).length,
      }))
    : work()
}

function parseState(output: string) {
  const sections = splitSections(output)
  const [identity, staged, status] = sections
  const head = identity?.[0]
  const prefix = identity?.[1]
  if (
    sections.length !== 4 ||
    sections[3]!.length !== 0 ||
    identity!.length !== 2 ||
    !head?.startsWith('h') ||
    !prefix?.startsWith('p')
  )
    throw new Error('Malformed architecture freshness output')
  const index = staged!.filter((record) => affectsArchitectureCapture(stagedPath(record)))
  return {
    head: head.slice(1),
    prefix: prefix.slice(1),
    index,
    status: parseStatus(status!, prefix.slice(1)),
    hidden: index
      .filter((record) => /^[a-z] /.test(record))
      .map((record) => prefix.slice(1) + stagedPath(record)),
  }
}

/** `git ls-files --stage -v` paths are relative to the workspace root. */
function stagedPath(record: string): string {
  return record.slice(record.indexOf('\t') + 1)
}

function splitSections(output: string): readonly (readonly string[])[] {
  const sections: string[][] = [[]]
  for (const record of output.split('\0')) {
    if (record === '') sections.push([])
    else sections.at(-1)!.push(record)
  }
  return sections.slice(0, -1)
}

/** Porcelain paths are relative to the repository root; the scan's are relative to `root`. */
function parseStatus(records: readonly string[], prefix: string): readonly StatusEntry[] {
  return records
    .map((record) => {
      const path = record.slice(3)
      if (record[2] !== ' ' || !path.startsWith(prefix))
        throw new Error('Invalid Git status entry')
      return { code: record.slice(0, 2), repositoryPath: path }
    })
    .filter((entry) =>
      affectsArchitectureCapture(entry.repositoryPath.slice(prefix.length)),
    )
}

function stdinPaths(paths: readonly string[]): string {
  for (const path of paths)
    // Git's --stdin-paths reads one path per line and unquotes a leading double quote.
    if (path.includes('\n') || path.startsWith('"'))
      throw new Error(`Unsupported source path in scan: ${JSON.stringify(path)}`)
  return paths.map((path) => `${path}\n`).join('')
}
