const { test } = require('node:test')
const assert = require('node:assert/strict')
const loader = require('../projects-load.js')

const BOARD = [
  'projects',
  'milestones',
  'artifacts',
  'decisions',
  'herSteps',
  'inProgress',
  'linked',
  'workflowRoots',
  'workflowSteps',
  'ancestors',
  'urgent',
  'sessions',
]
const KEPT = [...BOARD, 'outcomes']
const EARLY = '2026-11-13T02:43:00.000Z'
const LATE = '2026-11-13T02:48:00.000Z'

const fullPayload = (now, tag) => ({
  now,
  unread: [],
  ...Object.fromEntries(KEPT.map((field) => [field, [{ id: `${field}-${tag}` }]])),
})

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }
  return value
}

test('a first read keeps the board and the outcomes as last good reads and is not stale', () => {
  const result = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  assert.equal(result.stale, null)
  assert.deepEqual(result.payload, fullPayload(EARLY, 'a'))
  assert.equal(result.lastGood.board.at, EARLY)
  for (const field of BOARD)
    assert.deepEqual(result.lastGood.board.values[field], [{ id: `${field}-a` }])
  assert.deepEqual(result.lastGood.outcomes, {
    values: { outcomes: [{ id: 'outcomes-a' }] },
    at: EARLY,
  })
})

for (const field of BOARD.filter((entry) => entry !== 'projects')) {
  test(`a failed ${field} read puts back the whole board from the same earlier read, never a mix`, () => {
    const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
    const failed = { ...fullPayload(LATE, 'b'), [field]: [], unread: [field] }
    const result = loader.keepLastGood({ payload: failed, lastGood: first.lastGood })
    for (const member of BOARD)
      assert.deepEqual(result.payload[member], [{ id: `${member}-a` }])
    assert.deepEqual(result.payload.outcomes, [{ id: 'outcomes-b' }])
    assert.deepEqual(result.payload.unread, [])
    assert.deepEqual(result.stale, { failedAt: LATE, readAt: EARLY, needsReadAt: EARLY })
    assert.deepEqual(result.lastGood.board, first.lastGood.board)
    assert.deepEqual(result.lastGood.outcomes, {
      values: { outcomes: [{ id: 'outcomes-b' }] },
      at: LATE,
    })
  })
}

test('a failed outcomes read keeps only the outcomes and leaves the board fresh', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  const failed = { ...fullPayload(LATE, 'b'), outcomes: undefined, unread: ['outcomes'] }
  const result = loader.keepLastGood({ payload: failed, lastGood: first.lastGood })
  assert.deepEqual(result.payload.outcomes, [{ id: 'outcomes-a' }])
  for (const member of BOARD)
    assert.deepEqual(result.payload[member], [{ id: `${member}-b` }])
  assert.deepEqual(result.stale, { failedAt: LATE, readAt: EARLY })
})

test('a failed projects read keeps milestones, artifacts and the rest of the board from the same read', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  const failed = {
    ...fullPayload(LATE, 'b'),
    projects: [],
    milestones: [],
    artifacts: [],
    unread: ['projects'],
  }
  const result = loader.keepLastGood({ payload: failed, lastGood: first.lastGood })
  for (const member of BOARD)
    assert.deepEqual(result.payload[member], [{ id: `${member}-a` }])
  assert.deepEqual(result.payload.unread, [])
  assert.deepEqual(result.stale, { failedAt: LATE, readAt: EARLY, needsReadAt: EARLY })
})

test('a bead that is blocked in a fresh linked read never meets its stale in-progress copy', () => {
  const inProgress = { id: 'wk-1', status: 'in_progress', store: '/rigs/lead' }
  const blocked = { ...inProgress, status: 'blocked' }
  const first = loader.keepLastGood({
    payload: {
      ...fullPayload(EARLY, 'a'),
      linked: [inProgress],
      inProgress: [inProgress],
    },
  })
  const result = loader.keepLastGood({
    payload: {
      ...fullPayload(LATE, 'b'),
      linked: [blocked],
      inProgress: [],
      unread: ['inProgress'],
    },
    lastGood: first.lastGood,
  })
  assert.deepEqual(result.payload.linked, [inProgress])
  assert.deepEqual(result.payload.inProgress, [inProgress])
})

test('an answered decision is never shown beside the fresh step that followed its answer', () => {
  const ask = { id: 'dec-1', status: 'open', labels: ['needs/stephanie'] }
  const followUp = { id: 'dec-2', status: 'open', labels: ['needs/stephanie-step'] }
  const first = loader.keepLastGood({
    payload: { ...fullPayload(EARLY, 'a'), decisions: [ask], herSteps: [] },
  })
  const result = loader.keepLastGood({
    payload: {
      ...fullPayload(LATE, 'b'),
      decisions: [],
      herSteps: [followUp],
      unread: ['decisions'],
    },
    lastGood: first.lastGood,
  })
  assert.deepEqual(result.payload.decisions, [ask])
  assert.deepEqual(result.payload.herSteps, [])
})

test('a deleted project and its waits leave together or not at all', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  const result = loader.keepLastGood({
    payload: { ...fullPayload(LATE, 'b'), projects: [], linked: [], unread: ['linked'] },
    lastGood: first.lastGood,
  })
  assert.deepEqual(result.payload.projects, [{ id: 'projects-a' }])
  assert.deepEqual(result.payload.linked, [{ id: 'linked-a' }])
})

test('a board that has never read cleanly stays unread and does not mark the view stale', () => {
  const failed = { ...fullPayload(EARLY, 'a'), linked: [], unread: ['linked'] }
  const result = loader.keepLastGood({ payload: failed })
  assert.deepEqual(result.payload.linked, [])
  assert.deepEqual(result.payload.decisions, [{ id: 'decisions-a' }])
  assert.deepEqual(result.payload.unread, ['linked'])
  assert.equal(result.stale, null)
  assert.equal(result.lastGood.board, undefined)
})

test('a board failing twice keeps the read from before both failures', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  const middle = '2026-11-13T02:45:00.000Z'
  const second = loader.keepLastGood({
    payload: { ...fullPayload(middle, 'b'), linked: [], unread: ['linked'] },
    lastGood: first.lastGood,
  })
  const third = loader.keepLastGood({
    payload: { ...fullPayload(LATE, 'c'), urgent: [], unread: ['urgent'] },
    lastGood: second.lastGood,
  })
  assert.deepEqual(third.payload.linked, [{ id: 'linked-a' }])
  assert.deepEqual(third.payload.urgent, [{ id: 'urgent-a' }])
  assert.deepEqual(third.stale, { failedAt: LATE, readAt: EARLY, needsReadAt: EARLY })
})

test('a clean read after a failed one replaces the kept board and clears the stale mark', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  const failed = loader.keepLastGood({
    payload: { ...fullPayload(LATE, 'b'), linked: [], unread: ['linked'] },
    lastGood: first.lastGood,
  })
  const later = '2026-11-13T02:50:00.000Z'
  const result = loader.keepLastGood({
    payload: fullPayload(later, 'c'),
    lastGood: failed.lastGood,
  })
  assert.equal(result.stale, null)
  assert.deepEqual(result.payload.linked, [{ id: 'linked-c' }])
  assert.equal(result.lastGood.board.at, later)
})

test('keepLastGood leaves frozen payloads and kept reads untouched for every failed field', () => {
  const first = deepFreeze(
    loader.keepLastGood({ payload: deepFreeze(fullPayload(EARLY, 'a')) }).lastGood,
  )
  const before = JSON.stringify(first)
  for (const field of KEPT) {
    const payload = deepFreeze({ ...fullPayload(LATE, 'b'), unread: [field] })
    const snapshot = JSON.stringify(payload)
    loader.keepLastGood({ payload, lastGood: first })
    assert.equal(JSON.stringify(payload), snapshot)
    assert.equal(JSON.stringify(first), before)
  }
})

test('the Needs-you check is unknown only when its kept read is older than ten minutes', () => {
  assert.equal(loader.NEEDS_CHECK_LIMIT_MS, 10 * 60000)
  const at = (minutes) => new Date(Date.parse(EARLY) + minutes * 60000).toISOString()
  assert.equal(loader.needsUnchecked(null), null)
  assert.equal(loader.needsUnchecked({ failedAt: at(60), readAt: EARLY }), null)
  assert.equal(
    loader.needsUnchecked({ failedAt: at(10), readAt: EARLY, needsReadAt: EARLY }),
    null,
  )
  const since = new Date(EARLY).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  assert.equal(
    loader.needsUnchecked({ failedAt: at(11), readAt: EARLY, needsReadAt: EARLY }),
    `Couldn't check what needs you since ${since}`,
  )
})

test('a stale warning shows the date only for a time that is not from today', () => {
  const clock = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const dated = (iso) =>
    new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  const late = new Date(Date.parse(EARLY) + 48 * 3600000).toISOString()
  assert.equal(
    loader.staleText({ failedAt: LATE, readAt: EARLY }, Date.parse(LATE)),
    `Couldn't refresh at ${clock(LATE)}; showing what was read at ${clock(EARLY)}`,
  )
  assert.equal(
    loader.staleText({ failedAt: late, readAt: EARLY }, Date.parse(late)),
    `Couldn't refresh at ${clock(late)}; showing what was read at ${dated(EARLY)}`,
  )
})
