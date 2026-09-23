import { describe, expect, it } from 'vitest'

import { parseResolvedConfig } from '../src/main/gascity/gascity-config'
import { deriveCrew } from '../src/main/gascity/gascity-crew'
import {
  hasProjectedTierFields,
  parseRigListOutput,
  parseSessionListOutput,
  rigForPath,
} from '../src/main/gascity/gascity-parse'
import { hostPath } from '../src/shared'

import { HOST, CITY, sessionJson } from './gascity-crew-fixture'

/**
 * Verbatim shapes from a live city, which several earlier assumptions got wrong:
 * `[[named_session]]` is keyed by `template` (not `name`), an agent names its rig
 * with `dir`, sessions are named with the rig's *path* baked in, and a pooled
 * worker's `work_dir` is a worktree that lives nowhere near its rig.
 */
const LIVE_CITY = '/home/dev/gas-city'
const LIVE_MEM = '/home/dev/projects/mem'
const LIVE_GASCITY_RIG = '/home/dev/gascity'

const LIVE_SESSIONS = parseSessionListOutput(
  JSON.stringify({
    ok: true,
    schema_version: '1',
    sessions: [
      {
        id: 'gc-517749',
        name: `${LIVE_MEM}/mem-worker-2`,
        template: `${LIVE_MEM}/mem-worker`,
        alias: `${LIVE_MEM}/mem-worker-2`,
        state: 'asleep',
        work_dir: LIVE_MEM,
      },
      {
        id: 'gc-517622',
        name: `${LIVE_GASCITY_RIG}/polecat-3`,
        template: `${LIVE_GASCITY_RIG}/polecat`,
        alias: `${LIVE_GASCITY_RIG}/polecat-3`,
        state: 'active',
        // A worktree, nowhere near the rig root it belongs to.
        work_dir: '/home/dev/gascity-worktrees/polecat-3',
      },
      {
        id: 'gc-1',
        name: 'mayor',
        alias: 'mayor',
        template: 'mayor',
        state: 'active',
        work_dir: LIVE_CITY,
      },
    ],
  }),
  HOST,
)

const LIVE_CONFIG = parseResolvedConfig(`
[[agent]]
name = "mayor"
scope = "city"
max_active_sessions = 1

[[agent]]
name = "mem-pl"
dir = "mem"

[[agent]]
name = "mem-worker"
dir = "mem"
namepool = "mem-worker"
max_active_sessions = 4

[[agent]]
name = "polecat"
dir = "gascity"
namepool = "polecat"
max_active_sessions = 4

[[named_session]]
template = "mayor"
mode = "always"

[[named_session]]
template = "mem-pl"
mode = "always"

[[named_session]]
template = "project-lead"
scope = "rig"
dir = "decisions"
mode = "on_demand"
`)

describe('live gc config shapes', () => {
  it('keys a named session by template, since most carry no name', () => {
    expect([...LIVE_CONFIG.namedSessions.map((named) => named.name)].sort()).toEqual([
      'mayor',
      'mem-pl',
      'project-lead',
    ])
  })

  it("reads an agent's rig from dir, leaving city-scope agents rig-less", () => {
    expect(LIVE_CONFIG.agents.find((agent) => agent.name === 'mem-pl')?.rig).toBe('mem')
    expect(
      LIVE_CONFIG.agents.find((agent) => agent.name === 'mayor')?.rig,
    ).toBeUndefined()
  })

  it('gives a rig lead its rig via the agent its template names', () => {
    // `[[named_session]] template = "mem-pl"` declares no dir of its own.
    expect(LIVE_CONFIG.namedSessions.find((n) => n.name === 'mem-pl')?.rig).toBe('mem')
    expect(LIVE_CONFIG.namedSessions.find((n) => n.name === 'mayor')?.rig).toBeUndefined()
  })

  it('takes the rig from dir when the entry declares one', () => {
    const scoped = LIVE_CONFIG.namedSessions.find((n) => n.name === 'project-lead')
    expect(scoped?.rig).toBe('decisions')
    expect(scoped?.mode).toBe('on_demand')
  })
})

describe('live gc crew derivation', () => {
  function inWorkspace(rigRoot: string, rigName: string | undefined, city = false) {
    return deriveCrew({
      sessions: LIVE_SESSIONS,
      config: LIVE_CONFIG,
      rigRoot: hostPath(HOST, rigRoot),
      cityRoot: hostPath(HOST, LIVE_CITY),
      cityWorkspace: city,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'config',
      ...(rigName === undefined ? {} : { rigName }),
    })
  }

  it('names the hq rig so the renderer can address the city bead store', () => {
    expect(inWorkspace(LIVE_MEM, 'mem').hqRigName).toBe('hq')
    expect(inWorkspace(LIVE_CITY, 'hq', true).hqRigName).toBe('hq')
  })

  it('shows this rig only — its own lead, not the mayor — in a rig workspace', () => {
    const crew = inWorkspace(LIVE_MEM, 'mem')
    expect([...crew.members.map((member) => member.label)].sort()).toEqual([
      'mem-pl',
      'mem-worker-2',
    ])
    expect(crew.members.find((member) => member.label === 'mem-pl')?.tier).toBe('lead')
  })

  it('associates a worktree-based worker by its rig-qualified name', () => {
    // `work_dir` is /home/dev/gascity-worktrees/polecat-3 — containment alone
    // would never place this session in the gascity rig.
    const crew = inWorkspace(LIVE_GASCITY_RIG, 'gascity')
    expect(crew.members.map((member) => member.label)).toContain('polecat-3')
  })

  it('strips the rig path from card labels but keeps a usable command target', () => {
    const worker = inWorkspace(LIVE_MEM, 'mem').members.find(
      (member) => member.label === 'mem-worker-2',
    )
    expect(worker?.target).toBe('gc-517749')
    expect(worker?.poolName).toBe('mem-worker')
  })

  it('matches a bead assigned by either the bare or the rig-qualified name', () => {
    const worker = inWorkspace(LIVE_MEM, 'mem').members.find(
      (member) => member.label === 'mem-worker-2',
    )
    expect(worker?.identityKeys).toContain('mem-worker-2')
    expect(worker?.identityKeys).toContain(`${LIVE_MEM}/mem-worker-2`)
  })
})

describe('crew diagnostics', () => {
  it('reports the pinned count so a mis-read config is visible, not silent', () => {
    const derived = deriveCrew({
      sessions: LIVE_SESSIONS,
      config: LIVE_CONFIG,
      rigRoot: hostPath(HOST, LIVE_MEM),
      rigName: 'mem',
      cityRoot: hostPath(HOST, LIVE_CITY),
      cityWorkspace: false,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'config',
    })
    expect(derived.diagnostics.namedSessions).toBe(3)
    expect(derived.diagnostics.pinned).toBe(2)
    expect(derived.diagnostics.unmatched).toEqual([])
  })

  it('lists an in-scope session no named session or agent describes', () => {
    const derived = deriveCrew({
      sessions: parseSessionListOutput(
        JSON.stringify([
          { id: 'gc-9', name: `${LIVE_MEM}/ghost-1`, template: `${LIVE_MEM}/ghost` },
        ]),
        HOST,
      ),
      config: LIVE_CONFIG,
      rigRoot: hostPath(HOST, LIVE_MEM),
      rigName: 'mem',
      cityRoot: hostPath(HOST, LIVE_CITY),
      cityWorkspace: false,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'config',
    })
    expect(derived.diagnostics.unmatched).toEqual(['ghost-1'])
  })

  it('reports zero pinned when the config could not be read at all', () => {
    const derived = deriveCrew({
      sessions: LIVE_SESSIONS,
      config: { agents: [], namedSessions: [] },
      rigRoot: hostPath(HOST, LIVE_MEM),
      rigName: 'mem',
      cityRoot: hostPath(HOST, LIVE_CITY),
      cityWorkspace: false,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'config',
    })
    expect(derived.diagnostics).toMatchObject({ namedSessions: 0, pinned: 0 })
  })
})

describe('gc session list parsing', () => {
  it('normalizes a bare array of sessions and host-qualifies work_dir', () => {
    const sessions = parseSessionListOutput(JSON.stringify([sessionJson()]), HOST)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe('gc-11')
    expect(sessions[0]?.workDir).toEqual(hostPath(HOST, `${CITY}/rigs/mem`))
    expect(sessions[0]?.state).toBe('active')
  })

  it('accepts a sessions envelope and drops rows with no identity', () => {
    const stdout = JSON.stringify({
      sessions: [sessionJson({ id: 'gc-12', name: 'polecat-fig' }), { state: 'active' }],
    })
    const sessions = parseSessionListOutput(stdout, HOST)
    expect(sessions.map((session) => session.id)).toEqual(['gc-12'])
  })

  it('rejects output that is not JSON rather than reporting an empty crew', () => {
    expect(() => parseSessionListOutput('gc: not in a city directory', HOST)).toThrow(
      /not JSON/,
    )
  })

  it('detects gc-projected tier fields so the config read can be skipped', () => {
    const plain = parseSessionListOutput(JSON.stringify([sessionJson()]), HOST)
    const enriched = parseSessionListOutput(
      JSON.stringify([
        sessionJson({ pool: 'mem-worker', configured_named_session: false }),
      ]),
      HOST,
    )
    expect(hasProjectedTierFields(plain)).toBe(false)
    expect(hasProjectedTierFields(enriched)).toBe(true)
  })
})

describe('gc rig list parsing', () => {
  const rigs = parseRigListOutput(
    JSON.stringify([
      { name: 'hq', path: CITY },
      { name: 'mem', path: `${CITY}/rigs/mem` },
    ]),
  )

  it('resolves the nearest enclosing rig, not the city, for a rig workspace', () => {
    expect(rigForPath(rigs, `${CITY}/rigs/mem`)?.name).toBe('mem')
    expect(rigForPath(rigs, `${CITY}/rigs/mem/src`)?.name).toBe('mem')
  })

  it('resolves a city workspace to the HQ rig with no special case', () => {
    expect(rigForPath(rigs, CITY)?.name).toBe('hq')
  })

  it('returns nothing for a path outside every rig', () => {
    expect(rigForPath(rigs, '/tmp/elsewhere')).toBeUndefined()
  })
})
