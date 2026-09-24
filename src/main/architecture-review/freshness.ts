import { createHash } from 'node:crypto'
import type { HostPath } from '../../shared/host-path'
import type { ArchitectureComparisonMode } from '../../shared/architecture-review'
import type { ProjectHost } from '../project-host/project-host'
import { inArchitectureScope } from './capture-entries'
import type { ArchitectureScanRecorder } from './scan-recorder'

const TIMEOUT = 30_000
const MAX_OUTPUT = 4 * 1024 * 1024
const ENV = { GIT_OPTIONAL_LOCKS: '0' }

/** Only a Current end read from the working tree can change after capture (ADR-063). */
export function hasLiveCurrent(mode: ArchitectureComparisonMode): boolean {
  return mode !== 'branch-point'
}

/**
 * HEAD, the workspace prefix, the staged entries and the porcelain status, in one host
 * command. Every -z record is non-empty, so an empty record marks the end of a section.
 */
const SCRIPT = `
set -e
head=$(git rev-parse --verify HEAD)
prefix=$(git rev-parse --show-prefix)
printf 'h%s\\0p%s\\0\\0' "$head" "$prefix"
git ls-files --stage -z -- .
printf '\\0'
git status --porcelain=v1 -z --untracked-files=all --no-renames -- .
printf '\\0'
`

interface StatusEntry {
  readonly code: string
  /** Relative to the workspace root, as the scan names it. */
  readonly path: string
  /** Relative to the repository root, as `git hash-object --stdin-paths` resolves it. */
  readonly repositoryPath: string
}

/**
 * A digest of everything a live Current end, or an index Baseline, is read from: HEAD
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
  const objects = await worktreeObjects(exec, state.status)
  return createHash('sha256')
    .update(JSON.stringify({ ...state, objects }))
    .digest('hex')
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

/** Blob ids of the files whose working-tree bytes differ from the index; none when clean. */
async function worktreeObjects(
  exec: CheckedExec,
  status: readonly StatusEntry[],
): Promise<readonly string[]> {
  const hashed = status.filter((entry) => /[MTA?]/.test(entry.code[1] ?? ''))
  if (hashed.length === 0) return []
  const output = await exec(
    'git',
    ['hash-object', '--no-filters', '--stdin-paths'],
    stdinPaths(hashed.map((entry) => entry.repositoryPath)),
  )
  const objects = output.split('\n').filter(Boolean)
  if (objects.length !== hashed.length)
    throw new Error('Architecture freshness check returned a different file set')
  return objects
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
  return {
    head: head.slice(1),
    index: staged!.filter((record) =>
      inArchitectureScope(record.slice(record.indexOf('\t') + 1)),
    ),
    status: parseStatus(status!, prefix.slice(1)),
  }
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
      return {
        code: record.slice(0, 2),
        path: path.slice(prefix.length),
        repositoryPath: path,
      }
    })
    .filter((entry) => inArchitectureScope(entry.path))
}

function stdinPaths(paths: readonly string[]): string {
  for (const path of paths)
    // Git's --stdin-paths reads one path per line and unquotes a leading double quote.
    if (path.includes('\n') || path.startsWith('"'))
      throw new Error(`Unsupported source path in scan: ${JSON.stringify(path)}`)
  return paths.map((path) => `${path}\n`).join('')
}
