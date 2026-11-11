import {
  isBeadId,
  type BeadIssue,
  type BeadsUnavailable,
  type HostPath,
} from '../../shared'

const NO_DATABASE = /no beads project found|no database found/i
const SERVER_UNREACHABLE =
  /127\.0\.0\.1:0\b|:0: connect|dolt server (unreachable|is not running|not reachable)|not reachable \(external\)|auto-start is (disabled|suppressed)|externally managed/i

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
    const detail = stderr.split(/\r?\n/, 1)[0]?.trim() ?? ''
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

export function parseBeadsWhereOutput(stdout: string): string | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const path = (raw as Record<string, unknown>)['path']
  return typeof path === 'string' && path.startsWith('/') ? path : undefined
}

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
  return raw.map(parseBeadIssue)
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
  if (!isBeadId(id)) {
    throw new Error(`bd issue at index ${index} has an id that is not a valid bd id`)
  }
  if (typeof title !== 'string' || typeof status !== 'string') {
    throw new Error(`bd issue '${id}' is missing a title or status`)
  }
  const labelsRaw = record['labels']
  const metadata = parseMetadata(record['metadata'])
  return {
    id,
    title,
    status,
    priority: numberField(record, 'priority', 4),
    issueType: stringField(record, 'issue_type') ?? 'task',
    assignee: stringField(record, 'assignee'),
    labels: Array.isArray(labelsRaw)
      ? labelsRaw.filter((label): label is string => typeof label === 'string')
      : [],
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
    ...(metadata ? { metadata } : {}),
    dependencyCount: numberField(record, 'dependency_count', 0),
    dependentCount: numberField(record, 'dependent_count', 0),
  }
}

function parseMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).flatMap(
    ([key, raw]) =>
      typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
        ? [[key, String(raw)] as const]
        : [],
  )
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
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
