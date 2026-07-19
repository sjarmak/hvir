import { parse as parseToml } from 'smol-toml'

import { isRecord } from './gascity-parse'

/**
 * Structural extraction from `gc config show` (resolved city TOML).
 *
 * gc has no role or label field, so the crew hierarchy is derived from two
 * structural facts: which named sessions are pinned (`mode = "always"`, not
 * suspended) and which agents are multi-session (a namepool or an active-session
 * range). Both are read mechanically — this module makes no judgement about what
 * an agent is *for*.
 *
 * The resolved config's nesting has moved between gc versions (city-scope and
 * rig-scope both carry `named_session` arrays and `agents` tables), so the walk
 * below finds those keys wherever they sit and records the enclosing rig rather
 * than hard-coding a path. Anything it cannot recognize is left out, which
 * degrades the crew to "workers only" instead of inventing a hierarchy.
 */

export interface GasCityAgentConfig {
  /** Agent/template name as configured, unqualified. */
  readonly name: string
  /** Rig the agent is scoped to; absent for city-scope agents. */
  readonly rig?: string
  readonly workDir?: string
  /** Multi-session: has a namepool or an active-session range above one. */
  readonly pooled: boolean
  readonly poolName?: string
}

export interface GasCityNamedSessionConfig {
  readonly name: string
  readonly alias?: string
  /** Agent template this named session instantiates. */
  readonly agent?: string
  readonly mode: string
  readonly suspended: boolean
  readonly rig?: string
  /** Binding-qualified named sessions (`core.control-dispatcher`) are internal. */
  readonly binding?: string
  readonly workDir?: string
}

export interface GasCityResolvedConfig {
  readonly agents: readonly GasCityAgentConfig[]
  readonly namedSessions: readonly GasCityNamedSessionConfig[]
}

export const EMPTY_RESOLVED_CONFIG: GasCityResolvedConfig = {
  agents: [],
  namedSessions: [],
}

/** Depth cap: the resolved config is a few levels deep; this bounds a cycle-free walk. */
const MAX_DEPTH = 8

export function parseResolvedConfig(toml: string): GasCityResolvedConfig {
  const trimmed = toml.trim()
  if (trimmed === '') return EMPTY_RESOLVED_CONFIG
  let decoded: unknown
  try {
    decoded = parseToml(trimmed)
  } catch (reason) {
    throw new Error('gc config show returned output that is not TOML', { cause: reason })
  }
  if (!isRecord(decoded)) return EMPTY_RESOLVED_CONFIG
  const agents: GasCityAgentConfig[] = []
  const namedSessions: GasCityNamedSessionConfig[] = []
  walk(decoded, undefined, 0, agents, namedSessions)
  return { agents, namedSessions }
}

function walk(
  node: Record<string, unknown>,
  rig: string | undefined,
  depth: number,
  agents: GasCityAgentConfig[],
  namedSessions: GasCityNamedSessionConfig[],
): void {
  if (depth > MAX_DEPTH) return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'named_session') {
      for (const entry of asEntries(value)) {
        const parsed = parseNamedSession(entry, rig)
        if (parsed) namedSessions.push(parsed)
      }
      continue
    }
    if (key === 'agents' || key === 'agent') {
      for (const [name, entry] of namedEntries(value)) {
        const parsed = parseAgent(name, entry, rig)
        if (parsed) agents.push(parsed)
      }
      continue
    }
    if (key === 'rigs') {
      for (const [name, entry] of namedEntries(value)) {
        if (isRecord(entry)) walk(entry, name, depth + 1, agents, namedSessions)
      }
      continue
    }
    if (isRecord(value)) walk(value, rig, depth + 1, agents, namedSessions)
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (isRecord(entry)) walk(entry, rig, depth + 1, agents, namedSessions)
      }
    }
  }
}

/**
 * TOML expresses a collection either as an array of tables (each carrying its
 * own `name`) or as a table keyed by name. Both appear in resolved gc config;
 * this yields `(name, entry)` pairs for either.
 */
function namedEntries(value: unknown): readonly (readonly [string, unknown])[] {
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((entry) => [text(entry, 'name') ?? '', entry] as const)
      .filter(([name]) => name !== '')
  }
  if (isRecord(value)) {
    return Object.entries(value).filter(([, entry]) => isRecord(entry))
  }
  return []
}

function asEntries(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  return isRecord(value) ? [value] : []
}

function parseNamedSession(
  entry: Record<string, unknown>,
  rig: string | undefined,
): GasCityNamedSessionConfig | undefined {
  const name = text(entry, 'name')
  if (name === undefined) return undefined
  // A binding-qualified name (`core.control-dispatcher`) marks orchestration
  // plumbing rather than a crew identity.
  const dot = name.indexOf('.')
  return {
    name,
    mode: text(entry, 'mode') ?? '',
    suspended: entry['suspended'] === true,
    ...defined('alias', text(entry, 'alias')),
    ...defined('agent', text(entry, 'agent', 'template', 'session_template')),
    ...defined('rig', text(entry, 'rig') ?? rig),
    ...defined('binding', dot > 0 ? name.slice(0, dot) : undefined),
    ...defined('workDir', text(entry, 'work_dir')),
  }
}

function parseAgent(
  name: string,
  entry: unknown,
  rig: string | undefined,
): GasCityAgentConfig | undefined {
  if (!isRecord(entry)) return undefined
  const poolName = text(entry, 'namepool', 'pool')
  const maxActive = integer(entry, 'max_active_sessions')
  const minActive = integer(entry, 'min_active_sessions')
  const pooled =
    poolName !== undefined ||
    (maxActive !== undefined && maxActive > 1) ||
    (minActive !== undefined && minActive > 1)
  return {
    name,
    pooled,
    ...defined('rig', text(entry, 'rig') ?? rig),
    ...defined('workDir', text(entry, 'work_dir')),
    // The pool label the panel groups under falls back to the agent name, which
    // is what gc's own session classification uses when no namepool is named.
    ...defined('poolName', pooled ? (poolName ?? name) : undefined),
  }
}

function defined<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

function text(
  entry: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function integer(
  entry: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'bigint') return Number(value)
  }
  return undefined
}
