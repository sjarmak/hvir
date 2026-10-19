const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseSessions, parseConfig } = require('../crew-parse.js')
const { deriveCrew, crewView, activityBand } = require('../crew.js')

/**
 * Shapes from a live city (src/main/gascity COMPASS): named sessions keyed by template, agents
 * naming their rig with Dir, rig paths baked into session names, worktree work_dirs.
 */
const CITY = '/home/dev/gas-city'
const MEM = '/home/dev/projects/mem'
const GASCITY = '/home/dev/gascity'

const SESSIONS = parseSessions({
  sessions: [
    { id: 'gc-517749', name: `${MEM}/mem-worker-2`, template: `${MEM}/mem-worker`, alias: `${MEM}/mem-worker-2`, state: 'asleep', work_dir: MEM },
    { id: 'gc-517750', name: `${MEM}/mem-worker-1`, template: `${MEM}/mem-worker`, alias: `${MEM}/mem-worker-1`, state: 'active', work_dir: MEM, context_pct: 63 },
    {
      id: 'gc-517622',
      name: `${GASCITY}/polecat-3`,
      template: `${GASCITY}/polecat`,
      alias: `${GASCITY}/polecat-3`,
      state: 'active',
      work_dir: '/home/dev/gascity-worktrees/polecat-3',
    },
    { id: 'gc-1', name: 'mayor', alias: 'mayor', template: 'mayor', state: 'active', work_dir: CITY },
    { id: 'gc-2', session_name: 'mem-pl', alias: 'mem-pl', template: 'mem-pl', state: 'asleep', work_dir: MEM },
    {
      id: 'gc-3',
      session_name: 'core__control-dispatcher-gc-3',
      alias: 'mem/core.control-dispatcher',
      template: 'mem/core.control-dispatcher',
      state: 'active',
      work_dir: MEM,
    },
  ],
})

const CONFIG = parseConfig({
  config: {
    Agents: [
      { Name: 'mayor', Scope: 'city', MaxActiveSessions: 1 },
      { Name: 'mem-pl', Dir: 'mem' },
      { Name: 'mem-worker', Dir: 'mem', Namepool: 'mem-worker', MaxActiveSessions: 4 },
      { Name: 'polecat', Dir: 'gascity', Namepool: 'polecat', MaxActiveSessions: 4 },
      { Name: 'gascity-pl', Dir: 'gascity', WorkDir: GASCITY },
      { Name: 'control-dispatcher', Dir: 'mem', MaxActiveSessions: 1 },
    ],
    NamedSessions: [
      { Template: 'mayor', Mode: 'always' },
      { Template: 'mem-pl', Mode: 'always' },
      { Template: 'gascity-pl', Mode: 'always' },
      { Template: 'project-lead', Scope: 'rig', Dir: 'decisions', Mode: 'on_demand' },
    ],
  },
})

const RIGS = [
  { name: 'hq', path: CITY },
  { name: 'mem', path: MEM },
  { name: 'gascity', path: GASCITY },
]

function crewAt(rigRoot, rigName, { city = false, includeInternals = false, sessions = SESSIONS, config = CONFIG } = {}) {
  return deriveCrew({
    sessions,
    config,
    rigs: RIGS,
    rigRoot,
    rigName,
    cityRoot: CITY,
    hqRigName: 'hq',
    cityWorkspace: city,
    includeInternals,
    tierSource: 'config',
  })
}

const labels = (crew) => crew.members.map((member) => member.label)

test('the city workspace leads with the mayor, then rig leads, running before dormant', () => {
  const crew = crewAt(CITY, 'hq', { city: true })
  assert.equal(crew.scope, 'city')
  assert.deepEqual(
    crew.members.map((member) => [member.label, member.tier, member.poolName, member.cityLead === true]),
    [
      ['mayor', 'lead', undefined, true],
      ['mem-pl', 'lead', undefined, false],
      ['gascity-pl', 'lead', undefined, false],
      ['mem-worker-1', 'worker', 'mem-worker', false],
      ['mem-worker-2', 'worker', 'mem-worker', false],
      ['polecat-3', 'worker', 'polecat', false],
    ],
  )
  const dormant = crew.members.find((member) => member.label === 'gascity-pl')
  assert.equal(dormant.session, undefined)
  assert.equal(dormant.key, 'config:gascity-pl')
})

test('a rig workspace shows its own lead and workers, not the mayor', () => {
  const crew = crewAt(MEM, 'mem')
  assert.equal(crew.scope, 'rig')
  assert.deepEqual(labels(crew), ['mem-pl', 'mem-worker-1', 'mem-worker-2'])
})

test('a worktree-based worker is placed by its rig-qualified name', () => {
  assert.deepEqual(labels(crewAt(GASCITY, 'gascity')), ['gascity-pl', 'polecat-3'])
})

test('labels drop the rig path while the command target stays usable', () => {
  const worker = crewAt(MEM, 'mem').members.find((member) => member.label === 'mem-worker-2')
  assert.equal(worker.target, 'gc-517749')
  assert.ok(worker.identityKeys.includes('mem-worker-2'))
  assert.ok(worker.identityKeys.includes(`${MEM}/mem-worker-2`))
})

test('binding-qualified sessions are internal and hidden unless asked for', () => {
  assert.ok(!labels(crewAt(MEM, 'mem')).includes('core.control-dispatcher'))
  const internal = crewAt(MEM, 'mem', { includeInternals: true }).members.at(-1)
  assert.deepEqual([internal.label, internal.tier], ['core.control-dispatcher', 'internal'])
})

test('diagnostics count pinned identities and name sessions no config describes', () => {
  const ghost = parseSessions([{ id: 'gc-9', name: `${MEM}/ghost-1`, template: `${MEM}/ghost` }])
  const crew = crewAt(MEM, 'mem', { sessions: [...SESSIONS, ...ghost] })
  assert.deepEqual(crew.diagnostics, { namedSessions: 4, pinned: 3, unmatched: ['ghost-1'] })
})

test('with no config every session is a worker and no lead is invented', () => {
  const crew = crewAt(MEM, 'mem', { config: { agents: [], namedSessions: [] } })
  assert.ok(crew.members.every((member) => member.tier === 'worker'))
  assert.equal(crew.diagnostics.pinned, 0)
})

test('gc-projected tier fields are used verbatim when present', () => {
  const sessions = parseSessions([
    { id: 'a', name: 'lead-a', configured_named_session: true, work_dir: MEM },
    { id: 'b', name: 'w-1', pool: 'w', configured_named_session: false, work_dir: MEM },
  ])
  const crew = deriveCrew({
    sessions,
    config: { agents: [], namedSessions: [] },
    rigs: RIGS,
    rigRoot: MEM,
    rigName: 'mem',
    cityRoot: CITY,
    hqRigName: 'hq',
    cityWorkspace: false,
    includeInternals: false,
    tierSource: 'session-fields',
  })
  assert.deepEqual(
    crew.members.map((member) => [member.label, member.tier, member.poolName]),
    [
      ['lead-a', 'lead', undefined],
      ['w-1', 'worker', 'w'],
    ],
  )
})

test('activity bands collapse gc states and keep unknown words unknown', () => {
  assert.deepEqual(
    [undefined, 'not running', 'active', 'running', 'asleep', 'suspended', 'creating'].map(activityBand),
    ['dormant', 'dormant', 'active', 'active', 'idle', 'idle', 'other'],
  )
})

test('crew view groups workers by pool and prefers gc active_bead', () => {
  const members = crewAt(CITY, 'hq', { city: true }).members
  const withBead = members.map((member) =>
    member.label === 'polecat-3' ? { ...member, session: { ...member.session, activeBead: 'gc-42' } } : member,
  )
  const view = crewView(withBead, [{ id: 'gc-42', title: 'Fix the thing', status: 'in_progress', assignee: 'someone' }])
  assert.deepEqual(view.leads.map((card) => card.member.label), ['mayor', 'mem-pl', 'gascity-pl'])
  assert.deepEqual(
    view.pools.map((group) => [group.label, group.cards.map((card) => card.member.label)]),
    [
      ['mem-worker', ['mem-worker-1', 'mem-worker-2']],
      ['polecat', ['polecat-3']],
    ],
  )
  assert.deepEqual(view.pools[1].cards[0].bead, { id: 'gc-42', title: 'Fix the thing' })
  assert.equal(view.total, 6)
})

test('without active_bead an in-progress bead joins by exact identity, never an ambiguous one', () => {
  const members = crewAt(CITY, 'hq', { city: true }).members
  const view = crewView(members, [
    { id: 'm-1', title: 'Mayor work', status: 'in_progress', assignee: 'mayor' },
    { id: 'm-2', title: 'Worker work', status: 'in_progress', assignee: `${MEM}/mem-worker-2` },
    { id: 'm-3', title: 'Pool-wide', status: 'in_progress', assignee: 'mem-worker' },
    { id: 'm-4', title: 'Open only', status: 'open', assignee: 'mem-pl' },
  ])
  const beadOf = (label) =>
    [...view.leads, ...view.pools.flatMap((group) => group.cards)].find((card) => card.member.label === label).bead
  assert.deepEqual(beadOf('mayor'), { id: 'm-1', title: 'Mayor work' })
  assert.deepEqual(beadOf('mem-worker-2'), { id: 'm-2', title: 'Worker work' })
  // `mem-worker` is both workers' template basename, so it names neither.
  assert.equal(beadOf('mem-worker-1'), undefined)
  assert.equal(beadOf('mem-pl'), undefined)
})

test('an active_bead missing from the bead list still shows its id', () => {
  const [member] = crewAt(CITY, 'hq', { city: true }).members
  const view = crewView([{ ...member, session: { ...member.session, activeBead: 'x-9' } }], [])
  assert.deepEqual(view.leads[0].bead, { id: 'x-9', title: 'x-9' })
})
