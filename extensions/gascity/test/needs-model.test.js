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

const { parseOptions, cardHash, validAnswer } = require('../needs-model.js')

const withOptions = (value) => ({ id: 'dec-a1', title: 't', metadata: { 'gc.options': value } })
const encoded = (list) => JSON.stringify(list)

test('parseOptions returns the options of a well-formed gc.options list', () => {
  const options = parseOptions(withOptions(encoded([
    { letter: 'a', text: 'Ship it' },
    { letter: 'b', text: 'Hold' },
  ])))
  assert.deepEqual(options, [{ letter: 'a', text: 'Ship it' }, { letter: 'b', text: 'Hold' }])
})

test('parseOptions accepts exactly eight options and refuses nine', () => {
  const letters = 'abcdefghi'.split('')
  const list = (count) => letters.slice(0, count).map((letter) => ({ letter, text: `Option ${letter}` }))
  assert.equal(parseOptions(withOptions(encoded(list(8)))).length, 8)
  assert.deepEqual(parseOptions(withOptions(encoded(list(9)))), [])
})

test('parseOptions shows no buttons for every malformed shape', () => {
  const bad = [
    undefined,
    null,
    '',
    'not json',
    '{"letter":"a","text":"x"}',
    '[]',
    '"a"',
    42,
    encoded([{ letter: 'A', text: 'upper' }]),
    encoded([{ letter: 'ab', text: 'two chars' }]),
    encoded([{ letter: '1', text: 'digit' }]),
    encoded([{ letter: 'a', text: 'x' }, { letter: 'a', text: 'y' }]),
    encoded([{ letter: 'a', text: '' }]),
    encoded([{ letter: 'a', text: '   ' }]),
    encoded([{ letter: 'a' }]),
    encoded([{ text: 'no letter' }]),
    encoded([{ letter: 'a', text: 5 }]),
    encoded([null]),
    encoded([{ letter: 'a', text: 'fine' }, 'junk']),
  ]
  for (const value of bad) assert.deepEqual(parseOptions(withOptions(value)), [], String(value))
  assert.deepEqual(parseOptions({ id: 'dec-a1' }), [])
  assert.deepEqual(parseOptions(undefined), [])
})

test('cardHash is the lowercase hex SHA-256 of title, a newline and the description', async () => {
  assert.equal(
    await cardHash({ title: 'Pick a path', description: 'Choose A or B.\nSecond line' }),
    'bb2b1208d1632b0bf0da24429ff01ef3e7239aa96c73d013ca703bf47bf12ad7',
  )
  assert.equal(
    await cardHash({ title: 'Zoë', description: '✓' }),
    '0d6eb2490e0e4d85da50639784a5b8cb7216fa9618d0e48fe3b3b5fe3ba92d38',
  )
})

test('cardHash treats an absent description as empty and refuses non-text fields', async () => {
  assert.equal(
    await cardHash({ title: 'Only title' }),
    '953219f68a9e4f0e22449ce3b0d5e1b399308bff91c17fa0b75a5c3669ad5837',
  )
  assert.equal(await cardHash({ description: 'no title' }), undefined)
  assert.equal(await cardHash({ title: 't', description: 5 }), undefined)
  assert.equal(await cardHash(undefined), undefined)
})

test('validAnswer accepts only the contract shapes', () => {
  const sha = 'a'.repeat(64)
  assert.equal(validAnswer('dec-r30f', 'a', sha), true)
  for (const args of [
    ['dec-R30f', 'a', sha], ['dec-', 'a', sha], ['bead-1', 'a', sha], ['dec-a b', 'a', sha],
    ['dec-a1', 'A', sha], ['dec-a1', 'ab', sha], ['dec-a1', '', sha],
    ['dec-a1', 'a', 'A'.repeat(64)], ['dec-a1', 'a', 'a'.repeat(63)], ['dec-a1', 'a', 'a'.repeat(65)],
    [undefined, 'a', sha], ['dec-a1', 5, sha], ['dec-a1', 'a', undefined],
  ]) assert.equal(validAnswer(...args), false, args.join('|'))
})
