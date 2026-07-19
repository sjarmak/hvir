import { hostPath, type GasCitySession, type HostPath } from '../../shared'

/**
 * Normalization of `gc session list --json`. gc is an external CLI whose output
 * shape is not ours to control, so every field is read defensively: unknown
 * keys are ignored, malformed rows are dropped rather than guessed at, and a
 * row without an identity is not a session.
 */

/** gc has emitted both a bare array and a `{ sessions: [...] }` envelope. */
export function parseSessionListOutput(
  stdout: string,
  hostId: HostPath['hostId'],
): readonly GasCitySession[] {
  const trimmed = stdout.trim()
  if (trimmed === '') return []
  let decoded: unknown
  try {
    decoded = JSON.parse(trimmed)
  } catch (reason) {
    throw new Error('gc session list returned output that is not JSON', { cause: reason })
  }
  const rows = sessionRows(decoded)
  if (rows === undefined) {
    throw new Error('gc session list returned an unexpected JSON shape')
  }
  const sessions: GasCitySession[] = []
  for (const row of rows) {
    const session = parseSession(row, hostId)
    if (session) sessions.push(session)
  }
  return sessions
}

function sessionRows(decoded: unknown): readonly unknown[] | undefined {
  if (Array.isArray(decoded)) return decoded as readonly unknown[]
  if (!isRecord(decoded)) return undefined
  const sessions = decoded['sessions']
  if (Array.isArray(sessions)) return sessions as readonly unknown[]
  // An empty result is sometimes an object with no `sessions` key at all.
  return Object.keys(decoded).length === 0 ? [] : undefined
}

function parseSession(row: unknown, hostId: HostPath['hostId']): GasCitySession | undefined {
  if (!isRecord(row)) return undefined
  const id = text(row, 'id', 'session_id', 'sessionId')
  const name = text(row, 'name', 'session_name', 'sessionName') ?? id
  if (id === undefined || name === undefined) return undefined
  const workDirPath = text(row, 'work_dir', 'workDir', 'workdir', 'cwd')
  const contextPct = number(row, 'context_pct', 'contextPct')
  return {
    id,
    name,
    state: text(row, 'state', 'status') ?? 'unknown',
    ...optional('alias', text(row, 'alias')),
    ...optional('template', text(row, 'template', 'agent', 'template_name')),
    ...optional('provider', text(row, 'provider', 'provider_id', 'providerId')),
    ...optional(
      'workDir',
      workDirPath !== undefined && workDirPath.startsWith('/')
        ? hostPath(hostId, workDirPath)
        : undefined,
    ),
    ...optional('rig', text(row, 'rig')),
    ...optional('pool', text(row, 'pool')),
    ...optional(
      'configuredNamedSession',
      boolean(row, 'configured_named_session', 'configuredNamedSession'),
    ),
    ...optional('activeBead', text(row, 'active_bead', 'activeBead')),
    ...optional('contextPct', contextPct),
    ...optional('lastActive', text(row, 'last_active', 'lastActive', 'updated_at')),
  }
}

export interface GasCityRig {
  readonly name: string
  readonly path: string
}

/** Registered rigs and their roots, from `gc rig list --json`. */
export function parseRigListOutput(stdout: string): readonly GasCityRig[] {
  const trimmed = stdout.trim()
  if (trimmed === '') return []
  let decoded: unknown
  try {
    decoded = JSON.parse(trimmed)
  } catch {
    return []
  }
  const rows: readonly unknown[] = Array.isArray(decoded)
    ? decoded
    : isRecord(decoded) && Array.isArray(decoded['rigs'])
      ? decoded['rigs']
      : []
  const rigs: GasCityRig[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const name = text(row, 'name', 'rig')
    const path = text(row, 'path', 'dir', 'root')
    if (name !== undefined && path !== undefined && path.startsWith('/')) {
      rigs.push({ name, path })
    }
  }
  return rigs
}

/**
 * The rig whose root is the nearest ancestor of (or equal to) `path`. The HQ
 * rig — the city itself — is one of these, so a city workspace resolves to it
 * without a special case.
 */
export function rigForPath(
  rigs: readonly GasCityRig[],
  path: string,
): GasCityRig | undefined {
  let best: GasCityRig | undefined
  for (const rig of rigs) {
    const prefix = rig.path === '/' ? '/' : `${rig.path}/`
    if (path !== rig.path && !path.startsWith(prefix)) continue
    if (best === undefined || rig.path.length > best.path.length) best = rig
  }
  return best
}

/**
 * Whether gc already projects the tiering fields itself. When it does, hvir
 * uses them verbatim and skips parsing the resolved config entirely — the
 * Phase 2 feature detection the crew derivation branches on.
 */
export function hasProjectedTierFields(sessions: readonly GasCitySession[]): boolean {
  return sessions.some(
    (session) => session.configuredNamedSession !== undefined || session.pool !== undefined,
  )
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

function text(row: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function boolean(
  row: Record<string, unknown>,
  ...keys: readonly string[]
): boolean | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function number(
  row: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
