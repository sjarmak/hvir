import { describe, expect, it } from 'vitest'

import { parseResolvedConfig } from '../src/main/gascity/gascity-config'
import { deriveCrew } from '../src/main/gascity/gascity-crew'
import {
  hasProjectedTierFields,
  parseRigListOutput,
  parseSessionListOutput,
  rigForPath,
} from '../src/main/gascity/gascity-parse'
import { asHostId, hostPath, type GasCitySession } from '../src/shared'

const HOST = asHostId('local')
const CITY = '/home/dev/gas-city'
const RIG_ROOT = hostPath(HOST, `${CITY}/rigs/mem`)
const CITY_ROOT = hostPath(HOST, CITY)

function sessionJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gc-11',
    name: 'mem-worker-ash',
    template: 'mem/mem-worker',
    state: 'active',
    provider: 'claude',
    work_dir: `${CITY}/rigs/mem`,
    ...overrides,
  }
}

/**
 * A resolved city config shaped the way `gc config show` composes one: a
 * suspended pack-stamped lead alongside the hand-defined city-scope lead that
 * replaced it, plus a pooled worker agent.
 */
const RESOLVED_CONFIG = `
[[named_session]]
name = "mem-pl"
alias = "mem-pl"
agent = "mem-pl"
mode = "always"
work_dir = "${CITY}/rigs/mem"
rig = "mem"

[[named_session]]
name = "core.control-dispatcher"
agent = "control-dispatcher"
mode = "always"

[agents.mem-pl]
work_dir = "${CITY}/rigs/mem"

[agents.mem-worker]
namepool = "mem-worker"
min_active_sessions = 1
max_active_sessions = 4

[rigs.mem]
path = "${CITY}/rigs/mem"

[[rigs.mem.named_session]]
name = "project-lead"
agent = "project-lead"
mode = "always"
suspended = true
`

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
      JSON.stringify([sessionJson({ pool: 'mem-worker', configured_named_session: false })]),
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

describe('resolved config extraction', () => {
  const config = parseResolvedConfig(RESOLVED_CONFIG)

  it('reads named sessions from both city and rig scope', () => {
    expect(config.namedSessions.map((named) => named.name).sort()).toEqual([
      'core.control-dispatcher',
      'mem-pl',
      'project-lead',
    ])
  })

  it('keeps the suspended flag and the rig a nested named session came from', () => {
    const stamped = config.namedSessions.find((named) => named.name === 'project-lead')
    expect(stamped?.suspended).toBe(true)
    expect(stamped?.rig).toBe('mem')
  })

  it('marks binding-qualified named sessions', () => {
    const dispatcher = config.namedSessions.find((named) => named.binding !== undefined)
    expect(dispatcher?.binding).toBe('core')
  })

  it('classifies agents as pooled only when they are multi-session', () => {
    const worker = config.agents.find((agent) => agent.name === 'mem-worker')
    const lead = config.agents.find((agent) => agent.name === 'mem-pl')
    expect(worker?.pooled).toBe(true)
    expect(worker?.poolName).toBe('mem-worker')
    expect(lead?.pooled).toBe(false)
  })

  it('rejects output that is not TOML', () => {
    expect(() => parseResolvedConfig('{ "not": "toml" ')).toThrow(/not TOML/)
  })
})

/** Sessions spanning two rigs plus the city itself, as `gc session list` returns them. */
const CITY_WIDE = parseSessionListOutput(
  JSON.stringify([
    sessionJson({
      id: 'gc-100',
      name: 'mayor',
      alias: 'mayor',
      template: 'mayor',
      work_dir: CITY,
    }),
    sessionJson({
      id: 'gc-101',
      name: 'city-infra-polecat-fig',
      template: 'city-infra-polecat',
      work_dir: CITY,
    }),
    // A lead that sits at city scope but belongs to a rig — same work_dir as
    // the mayor, so only rig association can tell them apart.
    sessionJson({
      id: 'gc-102',
      name: 'city-infra-pl',
      alias: 'city-infra-pl',
      template: 'city-infra-pl',
      work_dir: CITY,
    }),
    sessionJson({ id: 'gc-1', name: 'mem-pl', alias: 'mem-pl', template: 'mem-pl' }),
    sessionJson({ id: 'gc-2', name: 'mem-worker-ash' }),
    sessionJson({
      id: 'gc-200',
      name: 'aoa-pl',
      alias: 'aoa-pl',
      template: 'aoa-pl',
      work_dir: `${CITY}/rigs/aoa`,
    }),
    sessionJson({
      id: 'gc-201',
      name: 'aoa-worker-elm',
      template: 'aoa/aoa-worker',
      work_dir: `${CITY}/rigs/aoa`,
    }),
  ]),
  HOST,
)

const CITY_WIDE_CONFIG = parseResolvedConfig(`
[[named_session]]
name = "mayor"
alias = "mayor"
agent = "mayor"
mode = "always"

[[named_session]]
name = "mem-pl"
alias = "mem-pl"
agent = "mem-pl"
mode = "always"
rig = "mem"

[[named_session]]
name = "aoa-pl"
alias = "aoa-pl"
agent = "aoa-pl"
mode = "always"
rig = "aoa"

[[named_session]]
name = "city-infra-pl"
alias = "city-infra-pl"
agent = "city-infra-pl"
mode = "always"
rig = "city-infra"

[agents.mem-worker]
namepool = "mem-worker"
max_active_sessions = 4

[agents.aoa-worker]
namepool = "aoa-worker"
max_active_sessions = 4

[agents.city-infra-polecat]
namepool = "city-infra-polecat"
max_active_sessions = 4
`)

/**
 * The shape a real city actually composes: rig project leads are *city-scope*
 * named sessions with no `rig` key at all — their rig association lives only in
 * `work_dir`, pointing at the rig root. The mayor is the one rooted at the city.
 */
const WORKDIR_SCOPED_CONFIG = parseResolvedConfig(`
[[named_session]]
name = "mayor"
alias = "mayor"
agent = "mayor"
mode = "always"

[[named_session]]
name = "mem-pl"
alias = "mem-pl"
agent = "mem-pl"
mode = "always"

[[named_session]]
name = "aoa-pl"
alias = "aoa-pl"
agent = "aoa-pl"
mode = "always"

[agents.mem-pl]
work_dir = "${CITY}/rigs/mem"

[agents.aoa-pl]
work_dir = "${CITY}/rigs/aoa"

[agents.mem-worker]
namepool = "mem-worker"
max_active_sessions = 4
`)

describe('rig leads defined at city scope', () => {
  function scoped(sessions: readonly GasCitySession[]) {
    return deriveCrew({
      sessions,
      config: WORKDIR_SCOPED_CONFIG,
      rigName: 'mem',
      rigRoot: RIG_ROOT,
      cityWorkspace: false,
      cityRoot: CITY_ROOT,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'config',
    })
  }

  it("keeps this rig's lead and the mayor, dropping another rig's lead", () => {
    const labels = scoped(CITY_WIDE).members.map((member) => member.label)
    expect([...labels].sort()).toEqual(['mayor', 'mem-pl', 'mem-worker-ash'])
  })

  it('scopes dormant leads by their configured work_dir, not by having no rig', () => {
    // Nothing running at all: every lead is dormant and only `work_dir` can say
    // which rig it belongs to.
    const labels = scoped([]).members.map((member) => member.label)
    expect([...labels].sort()).toEqual(['mayor', 'mem-pl'])
  })
})

describe('workspace scope', () => {
  function scopedTo(cityWorkspace: boolean) {
    return deriveCrew({
      sessions: CITY_WIDE,
      config: CITY_WIDE_CONFIG,
      rigName: cityWorkspace ? 'hq' : 'mem',
      rigRoot: cityWorkspace ? CITY_ROOT : RIG_ROOT,
      cityWorkspace,
      cityRoot: CITY_ROOT,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'config',
    })
  }

  it('shows every rig lead and worker from the city workspace', () => {
    const labels = scopedTo(true).members.map((member) => member.label)
    expect(labels).toEqual(
      expect.arrayContaining([
        'mayor',
        'mem-pl',
        'aoa-pl',
        'mem-worker-ash',
        'aoa-worker-elm',
        'city-infra-polecat-fig',
        'city-infra-pl',
      ]),
    )
  })

  it('pins every rig lead in the city workspace', () => {
    const leads = scopedTo(true)
      .members.filter((member) => member.tier === 'lead')
      .map((member) => member.label)
    expect([...leads].sort()).toEqual(['aoa-pl', 'city-infra-pl', 'mayor', 'mem-pl'])
  })

  it('narrows to this rig plus the city leads from a rig workspace', () => {
    const labels = scopedTo(false).members.map((member) => member.label)
    expect([...labels].sort()).toEqual(['mayor', 'mem-pl', 'mem-worker-ash'])
  })

  it("drops another rig's lead and workers from a rig workspace", () => {
    const labels = scopedTo(false).members.map((member) => member.label)
    expect(labels).not.toContain('aoa-pl')
    expect(labels).not.toContain('aoa-worker-elm')
  })

  it("drops the city's worker pools from a rig workspace", () => {
    expect(scopedTo(false).members.map((member) => member.label)).not.toContain(
      'city-infra-polecat-fig',
    )
  })

  it('keeps only the rig-less city lead, not every lead sitting at city scope', () => {
    // `city-infra-pl` has the mayor's work_dir but belongs to a rig, so rig
    // association is the only thing that separates them.
    expect(scopedTo(false).members.map((member) => member.label)).not.toContain(
      'city-infra-pl',
    )
  })
})

describe('crew derivation', () => {
  const config = parseResolvedConfig(RESOLVED_CONFIG)
  const sessions = parseSessionListOutput(
    JSON.stringify([
      sessionJson({ id: 'gc-1', name: 'mem-pl', alias: 'mem-pl', template: 'mem-pl' }),
      sessionJson({ id: 'gc-2', name: 'mem-worker-ash' }),
      sessionJson({ id: 'gc-3', name: 'mem-worker-bay' }),
      sessionJson({
        id: 'gc-4',
        name: 'core.control-dispatcher',
        template: 'control-dispatcher',
      }),
      sessionJson({
        id: 'gc-9',
        name: 'other-worker',
        template: 'aoa/aoa-worker',
        work_dir: '/home/dev/elsewhere',
      }),
    ]),
    HOST,
  )

  const crew = deriveCrew({
    sessions,
    config,
    rigName: 'mem',
    rigRoot: RIG_ROOT,
    cityWorkspace: false,
    cityRoot: CITY_ROOT,
    hqRigName: 'hq',
    includeInternals: false,
    tierSource: 'config',
  })

  it('excludes sessions whose work_dir is outside the rig root', () => {
    expect(crew.members.map((member) => member.label)).not.toContain('other-worker')
  })

  it('pins the configured always-on lead first', () => {
    expect(crew.members[0]?.tier).toBe('lead')
    expect(crew.members[0]?.label).toBe('mem-pl')
  })

  it('groups pool-backed sessions as workers under the pool name', () => {
    const workers = crew.members.filter((member) => member.tier === 'worker')
    expect(workers.map((member) => member.label)).toEqual([
      'mem-worker-ash',
      'mem-worker-bay',
    ])
    expect(new Set(workers.map((member) => member.poolName))).toEqual(
      new Set(['mem-worker']),
    )
  })

  it('hides binding-qualified sessions unless internals are requested', () => {
    expect(crew.members.some((member) => member.tier === 'internal')).toBe(false)
    const withInternals = deriveCrew({
      sessions,
      config,
      rigName: 'mem',
      rigRoot: RIG_ROOT,
      cityWorkspace: false,
      cityRoot: CITY_ROOT,
      hqRigName: 'hq',
      includeInternals: true,
      tierSource: 'config',
    })
    expect(
      withInternals.members.filter((member) => member.tier === 'internal'),
    ).toHaveLength(1)
  })

  it('drops the suspended pack lead instead of rendering two generations', () => {
    expect(crew.members.filter((member) => member.tier === 'lead')).toHaveLength(1)
    expect(crew.members.map((member) => member.label)).not.toContain('project-lead')
  })

  it('renders a pinned identity with no session as a dormant lead', () => {
    const dormant = deriveCrew({
      sessions: sessions.filter((session) => session.id !== 'gc-1'),
      config,
      rigName: 'mem',
      rigRoot: RIG_ROOT,
      cityWorkspace: false,
      cityRoot: CITY_ROOT,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'config',
    })
    const lead = dormant.members.find((member) => member.tier === 'lead')
    expect(lead?.label).toBe('mem-pl')
    expect(lead?.session).toBeUndefined()
  })

  it('pins a lead whose runtime name differs from its configured name', () => {
    // gc does not require a named session to run under its configured name; a
    // lead configured as `project-lead` can run as `mem-pl`. Matching on name
    // alone silently demoted it to a worker.
    const renamed = deriveCrew({
      sessions: parseSessionListOutput(
        JSON.stringify([
          sessionJson({ id: 'gc-30', name: 'lead-1', template: 'mem-pl' }),
        ]),
        HOST,
      ),
      config,
      rigName: 'mem',
      rigRoot: RIG_ROOT,
      cityWorkspace: false,
      cityRoot: CITY_ROOT,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'config',
    })
    expect(renamed.members.find((member) => member.label === 'lead-1')?.tier).toBe('lead')
  })

  it('never promotes a pool member that shares a template with a named session', () => {
    const pooled = deriveCrew({
      sessions: parseSessionListOutput(
        JSON.stringify([
          sessionJson({ id: 'gc-31', name: 'mem-worker-ash', template: 'mem-worker' }),
        ]),
        HOST,
      ),
      config: parseResolvedConfig(`
[[named_session]]
name = "pool-lead"
agent = "mem-worker"
mode = "always"
rig = "mem"

[agents.mem-worker]
namepool = "mem-worker"
max_active_sessions = 4
`),
      rigName: 'mem',
      rigRoot: RIG_ROOT,
      cityWorkspace: false,
      cityRoot: CITY_ROOT,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'config',
    })
    expect(pooled.members.find((member) => member.label === 'mem-worker-ash')?.tier).toBe(
      'worker',
    )
  })

  it('carries every identity gc matches active beads by', () => {
    const lead = crew.members.find((member) => member.tier === 'lead')
    expect(new Set(lead?.identityKeys)).toEqual(new Set(['gc-1', 'mem-pl']))
  })

  it('prefers gc-projected fields over the resolved config when present', () => {
    const enriched: readonly GasCitySession[] = parseSessionListOutput(
      JSON.stringify([
        sessionJson({
          id: 'gc-20',
          name: 'mayor',
          alias: 'mayor',
          configured_named_session: true,
        }),
        sessionJson({ id: 'gc-21', name: 'polecat-fig', pool: 'polecat' }),
      ]),
      HOST,
    )
    const projected = deriveCrew({
      sessions: enriched,
      config: { agents: [], namedSessions: [] },
      rigName: 'mem',
      rigRoot: RIG_ROOT,
      cityWorkspace: false,
      cityRoot: CITY_ROOT,
      hqRigName: 'hq',
      includeInternals: false,
      tierSource: 'session-fields',
    })
    expect(projected.tierSource).toBe('session-fields')
    expect(projected.members.map((member) => [member.label, member.tier])).toEqual([
      ['mayor', 'lead'],
      ['polecat-fig', 'worker'],
    ])
    expect(projected.members[1]?.poolName).toBe('polecat')
  })
})
