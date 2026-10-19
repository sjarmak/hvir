/* global window, module */
/**
 * Defensive normalization of the gc reads the crew needs (src/main/gascity/gascity-parse.ts and
 * gascity-config.ts): `gc session list --json`, `gc rig list --json` and `gc config show --json`.
 * gc's output is not ours to control, so unknown keys are ignored, rows without an identity are
 * dropped, and a shape that is not recognizably the command's is an error rather than "nothing".
 */
;(() => {
  const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

  function text(row, ...keys) {
    for (const key of keys) if (typeof row[key] === 'string' && row[key] !== '') return row[key]
    return undefined
  }

  function typed(type, row, ...keys) {
    for (const key of keys) if (typeof row[key] === type && (type !== 'number' || Number.isFinite(row[key]))) return row[key]
    return undefined
  }

  /** Copy of `fields` without its undefined entries, so absent facts stay absent. */
  const defined = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

  function rowsOf(decoded, key, command) {
    if (Array.isArray(decoded)) return decoded
    if (isRecord(decoded) && Array.isArray(decoded[key])) return decoded[key]
    // An empty result is sometimes an object with no list key at all.
    if (isRecord(decoded) && Object.keys(decoded).length === 0) return []
    throw new Error(`gc ${command} returned an unexpected JSON shape`)
  }

  function parseSession(row) {
    if (!isRecord(row)) return undefined
    const id = text(row, 'id', 'session_id', 'sessionId')
    if (id === undefined) return undefined
    const workDir = text(row, 'work_dir', 'workDir', 'workdir', 'cwd')
    return defined({
      id,
      name: text(row, 'name', 'session_name', 'sessionName') ?? id,
      state: text(row, 'state', 'status') ?? 'unknown',
      alias: text(row, 'alias'),
      template: text(row, 'template', 'agent', 'template_name'),
      provider: text(row, 'provider', 'provider_id', 'providerId'),
      workDir: workDir?.startsWith('/') ? workDir : undefined,
      rig: text(row, 'rig'),
      pool: text(row, 'pool'),
      configuredNamedSession: typed('boolean', row, 'configured_named_session', 'configuredNamedSession'),
      activeBead: text(row, 'active_bead', 'activeBead'),
      contextPct: typed('number', row, 'context_pct', 'contextPct'),
      lastActive: text(row, 'last_active', 'lastActive', 'updated_at'),
    })
  }

  /** Sessions from `gc session list --json`, which has emitted both a bare array and an envelope. */
  /** Raw `gc session list --json` rows, from either the bare-array or the envelope shape. */
  const sessionRows = (decoded) => rowsOf(decoded, 'sessions', 'session list')
  const parseSessions = (decoded) => sessionRows(decoded).map(parseSession).filter(Boolean)

  /** Whether gc projects the tiering fields itself, so the resolved config is not needed. */
  const hasProjectedTierFields = (sessions) =>
    sessions.some((session) => session.configuredNamedSession !== undefined || session.pool !== undefined)

  /**
   * City identity and rigs from `gc rig list --json`. gc marks the HQ rig (the city itself) with
   * `hq` and names the city root in `city_path`, so neither needs a filesystem probe.
   */
  function parseRigList(decoded) {
    const rigs = rowsOf(decoded, 'rigs', 'rig list')
      .filter(isRecord)
      .map((row) => ({ row, name: text(row, 'name', 'rig'), path: text(row, 'path', 'dir', 'root') }))
      .filter(({ name, path }) => name !== undefined && path?.startsWith('/'))
      .map(({ row, name, path }) => ({ name, path, hq: row.hq === true, suspended: row.suspended === true }))
    const hq = rigs.find((rig) => rig.hq)
    const envelope = isRecord(decoded) ? decoded : {}
    return defined({
      cityName: text(envelope, 'city_name') ?? hq?.name,
      cityRoot: text(envelope, 'city_path') ?? hq?.path,
      hqRigName: hq?.name,
      rigs,
    })
  }

  function parseNamedSession(entry) {
    // `Template` is the identity; `Name` is set only when an entry overrides it.
    const template = text(entry, 'Template')
    const name = text(entry, 'Name') ?? template
    if (name === undefined) return undefined
    // A binding-qualified name (`core.control-dispatcher`) marks orchestration plumbing.
    const dot = name.indexOf('.')
    return defined({
      name,
      mode: text(entry, 'Mode') ?? '',
      suspended: entry.Suspended === true,
      alias: text(entry, 'Alias'),
      agent: template,
      rig: text(entry, 'Dir'),
      binding: dot > 0 ? name.slice(0, dot) : undefined,
      workDir: text(entry, 'WorkDir'),
    })
  }

  function parseAgent(entry) {
    const name = text(entry, 'Name')
    if (name === undefined) return undefined
    const poolName = text(entry, 'Namepool')
    const maxActive = typed('number', entry, 'MaxActiveSessions')
    const minActive = typed('number', entry, 'MinActiveSessions')
    const pooled = poolName !== undefined || maxActive > 1 || minActive > 1
    return defined({
      name,
      pooled,
      // `Dir` is how an agent names its rig; city-scope agents have none.
      rig: text(entry, 'Dir'),
      workDir: text(entry, 'WorkDir'),
      // The pool label falls back to the agent name, as gc's own session classification does.
      poolName: pooled ? (poolName ?? name) : undefined,
    })
  }

  /**
   * A rig's project lead is declared at city scope with no `Dir` of its own; its rig is knowable
   * only through the agent its template names.
   */
  function withAgentRig(named, agents) {
    if (named.rig !== undefined || named.agent === undefined) return named
    const agent = agents.find((candidate) => candidate.name === named.agent)
    return agent?.rig === undefined ? named : { ...named, rig: agent.rig }
  }

  const entries = (value, parse) => (Array.isArray(value) ? value.filter(isRecord).map(parse).filter(Boolean) : [])

  /** Pinned identities and pooled agents from `gc config show --json` (Go field names). */
  function parseConfig(decoded) {
    if (!isRecord(decoded) || !isRecord(decoded.config)) throw new Error('gc config show returned an unexpected JSON shape')
    const agents = entries(decoded.config.Agents, parseAgent)
    const namedSessions = entries(decoded.config.NamedSessions, parseNamedSession).map((named) => withAgentRig(named, agents))
    return { agents, namedSessions }
  }

  const api = Object.freeze({ sessionRows, parseSessions, hasProjectedTierFields, parseRigList, parseConfig })
  if (typeof module === 'object') module.exports = api
  else window.crewParse = api
})()
