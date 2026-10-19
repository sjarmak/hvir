const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  NEEDS_LABEL,
  ASK_RIG,
  MAX_ASKS,
  decisionsRig,
  askArgs,
  openAsks,
} = require('../needs-model.js')
const { parseRigList } = require('../crew-parse.js')

const ask = (id, fields = {}) => ({
  id,
  title: `Ask ${id}`,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: [NEEDS_LABEL],
  ...fields,
})

test('the ask label and rig match the built-in Needs you', () => {
  assert.equal(NEEDS_LABEL, 'needs/stephanie')
  assert.equal(ASK_RIG, 'decisions')
})

test('decisionsRig finds the decisions rig in gc rig list output', () => {
  const { rigs } = parseRigList({
    ok: true,
    rigs: [
      { name: 'ds-research', path: '/home/ds/gas-city' },
      { name: 'decisions', path: '/home/ds/projects/decisions' },
      { name: 'stale', path: 'relative/decisions' },
    ],
  })
  assert.equal(decisionsRig(rigs).path, '/home/ds/projects/decisions')
  assert.equal(
    decisionsRig(parseRigList([{ name: 'decisions', path: 'projects/decisions' }]).rigs),
    undefined,
  )
  assert.equal(
    decisionsRig(parseRigList({ rigs: [{ name: 'omni', path: '/Users/x/omni' }] }).rigs),
    undefined,
  )
})

test('askArgs reads open labelled beads from the rig directory', () => {
  assert.deepEqual(askArgs('/srv/dec'), [
    '-C',
    '/srv/dec',
    'list',
    '--json',
    '--flat',
    '--no-pager',
    '--status',
    'open',
    '--label',
    'needs/stephanie',
    '-n',
    '0',
  ])
})

test('openAsks keeps open, labelled, unanswered beads only', () => {
  const issues = [
    ask('dec-1'),
    ask('dec-2', { metadata: { 'gc.answered': '2026-10-19' } }),
    ask('dec-3', { status: 'in_progress' }),
    ask('dec-4', { labels: ['needs-human'] }),
    ask('dec-5', { labels: ['Needs/Stephanie'], metadata: { 'gc.answered': '' } }),
    ask('dec-6', { labels: undefined }),
  ]
  const { asks, truncated } = openAsks(issues)
  assert.deepEqual(
    asks.map((issue) => issue.id),
    ['dec-1', 'dec-5'],
  )
  assert.equal(truncated, false)
})

test('openAsks caps the list at the built-in per-source limit and says so', () => {
  const issues = Array.from({ length: MAX_ASKS + 3 }, (_, index) =>
    ask(`dec-${index + 1}`),
  )
  const { asks, truncated, total } = openAsks(issues)
  assert.equal(MAX_ASKS, 50)
  assert.equal(asks.length, MAX_ASKS)
  assert.equal(asks.at(-1).id, `dec-${MAX_ASKS}`)
  assert.equal(total, MAX_ASKS + 3)
  assert.equal(truncated, true)
})

test('openAsks does not reorder or mutate its input', () => {
  const issues = Object.freeze([ask('dec-9'), ask('dec-7')])
  assert.deepEqual(
    openAsks(issues).asks.map((issue) => issue.id),
    ['dec-9', 'dec-7'],
  )
})
