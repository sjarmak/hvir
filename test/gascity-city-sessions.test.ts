import { describe, expect, it } from 'vitest'

import { EMPTY_RESOLVED_CONFIG } from '../src/main/gascity/gascity-config'
import type { GasCityContext } from '../src/main/gascity/gascity-context'
import { deriveCitySessions } from '../src/main/gascity/gascity-city-sessions'
import { asHostId, hostPath, type GasCitySession } from '../src/shared'

const HOST = asHostId('local')
const CITY = hostPath(HOST, '/home/dev/city')
const MEM = '/home/dev/city/rigs/mem'
const POLECAT = '/home/dev/city/rigs/polecat'

function context(overrides: Partial<GasCityContext> = {}): GasCityContext {
  return {
    rigs: [
      { name: 'mem', path: MEM },
      { name: 'polecat', path: POLECAT },
    ],
    cityRoot: CITY,
    config: {
      agents: [],
      namedSessions: [
        { name: 'mem-pl', mode: 'always', rig: 'mem', suspended: false },
        { name: 'mayor', mode: 'always', rig: 'city', suspended: false },
      ],
    },
    ...overrides,
  }
}

function session(overrides: Partial<GasCitySession> & { id: string }): GasCitySession {
  return {
    name: overrides.id,
    state: 'active',
    ...overrides,
  }
}

function derive(
  sessions: readonly GasCitySession[],
  options: {
    readonly includeInternals?: boolean
    readonly context?: GasCityContext
  } = {},
) {
  return deriveCitySessions({
    root: hostPath(HOST, MEM),
    cityRoot: CITY,
    sessions,
    context: options.context ?? context(),
    includeInternals: options.includeInternals === true,
  })
}

describe('deriveCitySessions', () => {
  it('carries across every fact gc reports', () => {
    const [fact] = derive([
      session({
        id: 'gc-7',
        name: 'mem-pl',
        state: 'active',
        provider: 'claude',
        workDir: hostPath(HOST, MEM),
        contextPct: 42,
        activeBead: 'hv-19',
        rig: 'mem',
      }),
    ])
    expect(fact).toMatchObject({
      sessionKey: 'gc-7',
      label: 'mem-pl',
      tier: 'lead',
      state: 'active',
      activity: 'active',
      provider: 'claude',
      contextPercent: 42,
      bead: 'hv-19',
      rigRoot: { hostId: HOST, path: MEM },
      workDir: { hostId: HOST, path: MEM },
    })
  })

  it('leaves out what gc does not report rather than filling it in', () => {
    const [fact] = derive([
      session({ id: 'gc-1', name: 'mem-worker-1', state: 'asleep' }),
    ])
    expect(fact).toMatchObject({ activity: 'idle', state: 'asleep' })
    expect(fact).not.toHaveProperty('provider')
    expect(fact).not.toHaveProperty('contextPercent')
    expect(fact).not.toHaveProperty('bead')
    expect(fact).not.toHaveProperty('workDir')
  })

  it('keeps an unrecognized gc state out of the activity vocabulary', () => {
    const [fact] = derive([session({ id: 'gc-1', state: 'reticulating' })])
    expect(fact).toMatchObject({ state: 'reticulating', activity: 'unknown' })
  })

  it('places a session in the rig whose root contains its working directory', () => {
    const [fact] = derive([
      session({
        id: 'gc-2',
        name: 'polecat-worker-1',
        workDir: hostPath(HOST, `${POLECAT}/deep/inside`),
      }),
    ])
    expect(fact?.rigRoot).toEqual({ hostId: HOST, path: POLECAT })
  })

  it('projects every rig on the host, not only the root the reads came from', () => {
    const facts = derive([
      session({ id: 'gc-1', name: 'mem-worker-1', workDir: hostPath(HOST, MEM) }),
      session({ id: 'gc-2', name: 'polecat-worker-1', workDir: hostPath(HOST, POLECAT) }),
    ])
    expect(facts.map((fact) => fact.sessionKey).sort()).toEqual(['gc-1', 'gc-2'])
  })

  it('omits a configured lead that is not running', () => {
    // A dormant pinned identity is the interesting part of a crew panel and has
    // no place in a list of sessions: there is no session to project.
    const facts = derive([session({ id: 'gc-1', name: 'mem-worker-1' })])
    expect(facts.map((fact) => fact.label)).toEqual(['mem-worker-1'])
  })

  it('omits orchestration internals unless they are asked for', () => {
    const internal = session({ id: 'gc-3', name: 'mem-pl.review' })
    expect(derive([internal])).toEqual([])
    expect(derive([internal], { includeInternals: true })).toHaveLength(1)
  })

  it('orders leads before workers, and running sessions before idle ones', () => {
    const facts = derive([
      session({ id: 'gc-1', name: 'mem-worker-2', state: 'asleep', pool: 'mem-worker' }),
      session({ id: 'gc-2', name: 'mem-worker-1', state: 'active', pool: 'mem-worker' }),
      session({
        id: 'gc-3',
        name: 'mem-pl',
        state: 'active',
        workDir: hostPath(HOST, MEM),
      }),
    ])
    expect(facts.map((fact) => fact.label)).toEqual([
      'mem-pl',
      'mem-worker-1',
      'mem-worker-2',
    ])
  })

  it('reads a city with no resolved config without inventing a crew', () => {
    const facts = derive([session({ id: 'gc-1', name: 'mem-worker-1' })], {
      context: context({ config: EMPTY_RESOLVED_CONFIG }),
    })
    expect(facts.map((fact) => fact.tier)).toEqual(['worker'])
  })
})
