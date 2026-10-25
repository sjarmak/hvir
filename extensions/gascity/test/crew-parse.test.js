const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseSessions,
  parseRigList,
  parseConfig,
  hasProjectedTierFields,
} = require('../crew-parse.js')

const CITY = '/home/dev/gas-city'

test('sessions: reads the envelope gc emits and normalizes its field names', () => {
  const [session] = parseSessions({
    _cache_age_s: 0,
    sessions: [
      {
        id: 'gc-11',
        template: 'mem/mem-worker',
        state: 'asleep',
        alias: 'mem/mem-worker-2',
        session_name: 'mem-worker-2-gc-11',
        work_dir: `${CITY}/rigs/mem`,
        last_active: '2026-10-15T11:11:01-04:00',
        context_pct: 42,
        active_bead: 'mem-7',
      },
    ],
  })
  assert.deepEqual(session, {
    id: 'gc-11',
    name: 'mem-worker-2-gc-11',
    state: 'asleep',
    alias: 'mem/mem-worker-2',
    template: 'mem/mem-worker',
    workDir: `${CITY}/rigs/mem`,
    activeBead: 'mem-7',
    contextPct: 42,
    lastActive: '2026-10-15T11:11:01-04:00',
  })
})

test('sessions: accepts a bare array, drops rows with no identity, ignores relative work_dir', () => {
  const sessions = parseSessions([
    { id: 'gc-12', state: 'active', work_dir: 'rigs/mem' },
    { state: 'active' },
  ])
  assert.deepEqual(sessions, [{ id: 'gc-12', name: 'gc-12', state: 'active' }])
})

test('sessions: an unexpected shape is an error, not an empty crew', () => {
  assert.throws(() => parseSessions({ error: 'no city' }), /unexpected JSON shape/)
  assert.deepEqual(parseSessions({}), [])
})

test('sessions: gc-projected tier fields are detected', () => {
  assert.equal(hasProjectedTierFields(parseSessions([{ id: 'a' }])), false)
  assert.equal(
    hasProjectedTierFields(parseSessions([{ id: 'a', pool: 'mem-worker' }])),
    true,
  )
  assert.equal(
    hasProjectedTierFields(parseSessions([{ id: 'a', configured_named_session: false }])),
    true,
  )
})

test('rig list: city name, root and hq rig come from gc itself', () => {
  const list = parseRigList({
    city_name: 'ds-research',
    city_path: CITY,
    ok: true,
    rigs: [
      { name: 'ds-research', path: CITY, hq: true, suspended: false, running: true },
      {
        name: 'mem',
        path: '/home/dev/projects/mem',
        hq: false,
        suspended: true,
        running: false,
      },
      { name: 'broken', path: 'relative' },
    ],
  })
  assert.deepEqual(list, {
    cityName: 'ds-research',
    cityRoot: CITY,
    hqRigName: 'ds-research',
    rigs: [
      { name: 'ds-research', path: CITY, hq: true, suspended: false },
      { name: 'mem', path: '/home/dev/projects/mem', hq: false, suspended: true },
    ],
  })
})

test('rig list: without city_path the hq rig still names the city root', () => {
  const list = parseRigList([{ name: 'hq', path: CITY, hq: true }])
  assert.equal(list.cityRoot, CITY)
  assert.equal(list.cityName, 'hq')
})

test('rig list: an unexpected shape is an error', () => {
  assert.throws(() => parseRigList({ error: 'x' }), /unexpected JSON shape/)
})

/** `gc config show --json` as gc emits it: Go field names, empty strings for unset values. */
const CONFIG = {
  ok: true,
  config: {
    Agents: [
      { Name: 'mayor', Dir: '', Scope: 'city', MaxActiveSessions: 1, Namepool: '' },
      { Name: 'mem-pl', Dir: 'mem', MaxActiveSessions: 1 },
      { Name: 'mem-worker', Dir: 'mem', Namepool: 'mem-worker', MaxActiveSessions: 4 },
      {
        Name: 'decisions-worker',
        Dir: '/home/dev/projects/decisions',
        MaxActiveSessions: 3,
        MinActiveSessions: 2,
      },
      {
        Name: 'canary',
        Dir: CITY,
        WorkDir: `${CITY}/canary`,
        MaxActiveSessions: 1,
        MinActiveSessions: null,
      },
    ],
    NamedSessions: [
      { Name: '', Template: 'mayor', Scope: '', Dir: '', Mode: 'always' },
      { Name: '', Template: 'mem-pl', Scope: '', Dir: '', Mode: 'always' },
      {
        Name: 'scix-pl',
        Template: 'scix-experiments-pl',
        Scope: '',
        Dir: '',
        Mode: 'always',
      },
      {
        Name: '',
        Template: 'project-lead',
        Scope: 'rig',
        Dir: 'decisions',
        Mode: 'on_demand',
      },
      {
        Name: '',
        Template: 'core.control-dispatcher',
        Dir: '',
        Mode: 'always',
        Suspended: true,
      },
      { Name: '', Template: '', Dir: '', Mode: 'always' },
    ],
  },
}

test('config: a named session is keyed by template, Name overrides it', () => {
  const { namedSessions } = parseConfig(CONFIG)
  assert.deepEqual(
    namedSessions.map((named) => named.name),
    ['mayor', 'mem-pl', 'scix-pl', 'project-lead', 'core.control-dispatcher'],
  )
  assert.equal(namedSessions[2].agent, 'scix-experiments-pl')
})

test('config: a rig lead gets its rig through the agent its template names', () => {
  const byName = new Map(
    parseConfig(CONFIG).namedSessions.map((named) => [named.name, named]),
  )
  assert.equal(byName.get('mem-pl').rig, 'mem')
  assert.equal(byName.get('mayor').rig, undefined)
  assert.equal(byName.get('project-lead').rig, 'decisions')
  assert.equal(byName.get('project-lead').mode, 'on_demand')
})

test('config: binding-qualified names are bindings, suspension is read', () => {
  const dispatcher = parseConfig(CONFIG).namedSessions.find(
    (named) => named.name === 'core.control-dispatcher',
  )
  assert.equal(dispatcher.binding, 'core')
  assert.equal(dispatcher.suspended, true)
})

test('config: pooled is a namepool or an active-session range above one', () => {
  const agents = new Map(parseConfig(CONFIG).agents.map((agent) => [agent.name, agent]))
  assert.deepEqual(agents.get('mayor'), { name: 'mayor', pooled: false })
  assert.deepEqual(agents.get('mem-worker'), {
    name: 'mem-worker',
    pooled: true,
    rig: 'mem',
    poolName: 'mem-worker',
  })
  assert.equal(agents.get('decisions-worker').poolName, 'decisions-worker')
  assert.deepEqual(agents.get('canary'), {
    name: 'canary',
    pooled: false,
    rig: CITY,
    workDir: `${CITY}/canary`,
  })
})

test('config: null collections are empty, a missing config object is an error', () => {
  assert.deepEqual(parseConfig({ config: { Agents: null, NamedSessions: null } }), {
    agents: [],
    namedSessions: [],
  })
  assert.throws(() => parseConfig({ ok: false }), /unexpected JSON shape/)
})
