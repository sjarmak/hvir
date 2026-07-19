/**
 * Pure parsing, classification, and path helpers for the beads bridge. Split
 * out of `beads-service.ts` so the service is the orchestration facade and the
 * `bd` output shapes are defined — and unit-tested — in one place with no host
 * or process dependencies.
 */

import {
  hostPath,
  type BeadDependencyEdge,
  type BeadGate,
  type BeadIssue,
  type BeadsUnavailable,
  type HostPath,
} from '../../shared'

/** bd could not find a beads project/database under the requested root. */
const NO_DATABASE = /no beads project found|no database found/i
/**
 * bd found a database configured for a Dolt server it cannot reach. The
 * hallmark is an unresolved port (`127.0.0.1:0`), but bd phrases the same
 * failure several ways depending on why the port never resolved.
 */
const SERVER_UNREACHABLE =
  /127\.0\.0\.1:0\b|:0: connect|dolt server (unreachable|is not running|not reachable)|not reachable \(external\)|auto-start is (disabled|suppressed)|externally managed/i

/**
 * Turn a non-zero `bd list` into a typed, actionable unavailability. The
 * server-unreachable case is called out specifically because its raw stderr
 * ("dial tcp 127.0.0.1:0: connect: connection refused") tells a user nothing
 * about the real fix — a missing or invalid `.beads/dolt-server.port`.
 */
export function classifyListFailure(
  root: HostPath,
  stderr: string,
  code: number | null,
): BeadsUnavailable {
  if (NO_DATABASE.test(stderr)) {
    return {
      available: false,
      reason: 'no-database',
      message: 'No beads database in this project.',
    }
  }
  if (SERVER_UNREACHABLE.test(stderr)) {
    const detail = firstLine(stderr)
    return {
      available: false,
      reason: 'server-unreachable',
      message:
        `Beads Dolt server is not reachable — bd could not resolve a server port. ` +
        `Check that ${root.path}/.beads/dolt-server.port exists and holds the shared ` +
        `Dolt port, or set BEADS_DOLT_SERVER_PORT.` +
        (detail ? ` (bd: ${detail})` : ''),
    }
  }
  return {
    available: false,
    reason: 'error',
    message: stderr || `bd exited with code ${code}`,
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? ''
}

/**
 * Log the workspace root, the exact `bd` argv, and the exit code + stderr on a
 * failed `bd list`. Deliberately never logs stdout (issue data) — only the
 * command and its error channel, which carry no credentials.
 */
export function logBeadsFailure(
  root: HostPath,
  args: readonly string[],
  outcome: {
    readonly code?: number | null
    readonly stderr?: string
    readonly thrown?: string
  },
): void {
  console.error('[beads] bd list failed', {
    host: root.hostId,
    root: root.path,
    command: 'bd (login shell)',
    argv: args.join(' '),
    ...(outcome.thrown !== undefined ? { error: outcome.thrown } : {}),
    ...(outcome.code !== undefined ? { code: outcome.code } : {}),
    ...(outcome.stderr ? { stderr: outcome.stderr } : {}),
  })
}

/** Parse `bd list --json` output; exported for tests. */
export function parseBeadsListOutput(stdout: string): readonly BeadIssue[] {
  const trimmed = stdout.trim()
  if (trimmed === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    throw new Error('bd returned output that is not valid JSON')
  }
  if (!Array.isArray(raw)) throw new Error('bd returned JSON that is not an issue list')
  return raw.map((candidate, index) => parseBeadIssue(candidate, index))
}

function parseBeadIssue(candidate: unknown, index: number): BeadIssue {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`bd issue at index ${index} is not an object`)
  }
  const record = candidate as Record<string, unknown>
  const id = record['id']
  const title = record['title']
  const status = record['status']
  if (typeof id !== 'string' || id === '') {
    throw new Error(`bd issue at index ${index} is missing an id`)
  }
  if (typeof title !== 'string' || typeof status !== 'string') {
    throw new Error(`bd issue '${id}' is missing a title or status`)
  }
  const labelsRaw = record['labels']
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw.filter((label): label is string => typeof label === 'string')
    : []
  return {
    id,
    title,
    status,
    priority: numberField(record, 'priority', 4),
    issueType: stringField(record, 'issue_type') ?? 'task',
    assignee: stringField(record, 'assignee'),
    labels,
    description: stringField(record, 'description'),
    design: stringField(record, 'design'),
    acceptanceCriteria: stringField(record, 'acceptance_criteria'),
    notes: stringField(record, 'notes'),
    parent: stringField(record, 'parent'),
    createdAt: stringField(record, 'created_at'),
    updatedAt: stringField(record, 'updated_at'),
    closedAt: stringField(record, 'closed_at'),
    closeReason: stringField(record, 'close_reason'),
    deferUntil: stringField(record, 'defer_until'),
    ...(parseMetadata(record['metadata'])
      ? { metadata: parseMetadata(record['metadata']) }
      : {}),
    dependencyCount: numberField(record, 'dependency_count', 0),
    dependentCount: numberField(record, 'dependent_count', 0),
  }
}

/** Flatten bd's metadata object to string→string, dropping non-scalar values. */
function parseMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Parse `bd list --format digraph` into blocking edges. Each non-empty line is
 * `<blocker> <blocked> [<blocked> …]` (whitespace-separated); the first token
 * blocks each of the rest. Lines with a single token contribute no edge.
 */
export function parseDigraphEdges(stdout: string): readonly BeadDependencyEdge[] {
  const edges: BeadDependencyEdge[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const tokens = line
      .trim()
      .split(/\s+/)
      .filter((token) => token !== '')
    const [blockerId, ...blocked] = tokens
    if (blockerId === undefined || blocked.length === 0) continue
    for (const blockedId of blocked) {
      edges.push({ blockerId, blockedId })
    }
  }
  return edges
}

/** Parse `bd gate list --json` into typed gates; tolerant of field-name variants. */
export function parseGatesOutput(stdout: string): readonly BeadGate[] {
  const trimmed = stdout.trim()
  if (trimmed === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const gates: BeadGate[] = []
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    const id = stringField(record, 'id')
    if (id === undefined) continue
    gates.push({
      id,
      title: stringField(record, 'title') ?? id,
      gateType:
        stringField(record, 'gate_type') ?? stringField(record, 'type') ?? 'human',
      blockedId:
        stringField(record, 'blocked_id') ??
        stringField(record, 'issue_id') ??
        stringField(record, 'blocks'),
      state: stringField(record, 'state') ?? stringField(record, 'status') ?? 'open',
    })
  }
  return gates
}

/**
 * Parse a dispatchability predicate's output into ids. Accepts a compact JSON
 * array of ids, a JSON array of bead objects (with an `id`), or a stream of
 * either one-per-line. Anything unrecognised contributes nothing.
 */
export function parseDispatchableOutput(stdout: string): readonly string[] {
  const ids = new Set<string>()
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value !== '') ids.add(value)
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>)['id']
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
  }
  const consume = (parsed: unknown): void => {
    if (Array.isArray(parsed)) parsed.forEach(collect)
    else collect(parsed)
  }
  const trimmed = stdout.trim()
  if (trimmed === '') return []
  try {
    consume(JSON.parse(trimmed))
  } catch {
    // Not a single JSON document — try newline-delimited JSON (jq `.[]` output).
    for (const line of trimmed.split(/\r?\n/)) {
      const piece = line.trim()
      if (piece === '') continue
      try {
        consume(JSON.parse(piece))
      } catch {
        // A bare unquoted id token on its own line.
        ids.add(piece)
      }
    }
  }
  return [...ids]
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberField(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function watchKey(root: HostPath): string {
  return `${root.hostId}:${root.path}`
}

export function joinRoot(root: HostPath, name: string): HostPath {
  return hostPath(root.hostId, root.path === '/' ? `/${name}` : `${root.path}/${name}`)
}
