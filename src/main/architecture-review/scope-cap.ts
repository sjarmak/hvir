import { ARCHITECTURE_SCOPE as SCOPE } from '../../shared/architecture-review'
import type { ArchitectureReviewSnapshot } from '../../shared/architecture-review'
import type {
  ArchitectureScanOutcome,
  ArchitectureScopeCandidate,
  ArchitectureScopeRefusal,
} from '../../shared/architecture-scope'

/** A path a scan would read, with its size when the listing carried one. */
export interface SizedPath {
  readonly path: string
  readonly size?: number
}
export interface ScopeCapContext {
  readonly end: string
  readonly scope: readonly string[]
}
export interface ScopeCap {
  readonly maxFiles: number
  readonly maxTotalBytes: number
}

const MAX_CANDIDATES = 24

/** The scan is above the cap; nothing of it was read and nothing of it is returned. */
export class ArchitectureScopeRefusalError extends Error {
  constructor(readonly refusal: ArchitectureScopeRefusal) {
    super(refusal.message)
  }
}

/** Refuses before any byte is read when `entries` exceed the cap in files or known bytes. */
export function assertWithinScopeCap(
  entries: readonly SizedPath[],
  context: ScopeCapContext,
  cap: ScopeCap = SCOPE,
): void {
  const bytes = entries.every((entry) => entry.size !== undefined)
    ? entries.reduce((total, entry) => total + entry.size!, 0)
    : null
  if (entries.length > cap.maxFiles || (bytes !== null && bytes > cap.maxTotalBytes))
    throw refusal(entries, bytes, context, cap)
}

/** The live listing has no sizes; the host sums them before sending any content. */
export function liveBytesRefusal(
  entries: readonly SizedPath[],
  bytes: number,
  context: ScopeCapContext,
): ArchitectureScopeRefusalError {
  return refusal(entries, bytes, context, SCOPE)
}

/** A refusal is an answer the renderer shows, not a failure; anything else still throws. */
export async function architectureScanOutcome(
  scan: Promise<ArchitectureReviewSnapshot>,
): Promise<ArchitectureScanOutcome> {
  try {
    return await scan
  } catch (error) {
    if (error instanceof ArchitectureScopeRefusalError) return { refused: error.refusal }
    throw error
  }
}

function refusal(
  entries: readonly SizedPath[],
  bytes: number | null,
  context: ScopeCapContext,
  cap: ScopeCap,
): ArchitectureScopeRefusalError {
  const measured = bytes === null ? '' : ` (${formatBytes(bytes)})`
  const where = context.scope.length
    ? `in scope ${context.scope.join(', ')}`
    : 'in the whole repository'
  return new ArchitectureScopeRefusalError({
    message:
      `Architecture scan refused: ${context.end} has ${count(entries.length)} files${measured} ${where}, ` +
      `above the cap of ${count(cap.maxFiles)} files and ${formatBytes(cap.maxTotalBytes)}. ` +
      'Choose a narrower scope and scan again; the review never reads part of a scope.',
    end: context.end,
    scope: context.scope,
    files: entries.length,
    bytes,
    maxFiles: cap.maxFiles,
    maxBytes: cap.maxTotalBytes,
    candidates: candidates(entries, context.scope, bytes !== null),
  })
}

/** Paths one level inside the measured scope, so each is strictly narrower than it. */
function candidates(
  entries: readonly SizedPath[],
  scope: readonly string[],
  sized: boolean,
): readonly ArchitectureScopeCandidate[] {
  const totals = new Map<string, { files: number; bytes: number }>()
  for (const entry of entries) {
    const path = candidateOf(entry.path, scope)
    if (path === undefined) continue
    const total = totals.get(path) ?? { files: 0, bytes: 0 }
    totals.set(path, { files: total.files + 1, bytes: total.bytes + (entry.size ?? 0) })
  }
  return [...totals]
    .map(([path, total]) => ({
      path,
      files: total.files,
      bytes: sized ? total.bytes : null,
    }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
    .slice(0, MAX_CANDIDATES)
}

/** Undefined for a config read from outside a narrowed scope: it cannot narrow it further. */
function candidateOf(path: string, scope: readonly string[]): string | undefined {
  const base = scope.length
    ? scope
        .filter((prefix) => path === prefix || path.startsWith(`${prefix}/`))
        .sort((a, b) => b.length - a.length)[0]
    : ''
  if (base === undefined) return undefined
  const depth = base === '' ? 0 : base.split('/').length
  return path
    .split('/')
    .slice(0, depth + 1)
    .join('/')
}

function count(value: number): string {
  return value.toLocaleString('en-US')
}

function formatBytes(bytes: number): string {
  const mib = 1024 * 1024
  if (bytes < mib) return `${count(bytes)} bytes`
  return Number.isInteger(bytes / mib)
    ? `${bytes / mib} MiB`
    : `${(bytes / mib).toFixed(1)} MiB`
}
