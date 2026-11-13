const { test } = require('node:test')
const assert = require('node:assert/strict')
const loader = require('../projects-load.js')

const BOARD = [
  'outcomes',
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
const EARLY = '2026-11-13T02:43:00.000Z'
const LATE = '2026-11-13T02:48:00.000Z'

const fullPayload = (now, tag) => ({
  now,
  unread: [],
  ...Object.fromEntries(BOARD.map((field) => [field, [{ id: `${field}-${tag}` }]])),
})

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }
  return value
}

test('a first read keeps the board with its outcomes as one last good read and is not stale', () => {
  const result = loader.keepLastGood({ payload: fullPayload(EARLY, 'a'), needsReadAt: EARLY })
  assert.equal(result.stale, null)
  assert.deepEqual(result.payload, fullPayload(EARLY, 'a'))
  assert.deepEqual(Object.keys(result.lastGood).sort(), ['board', 'needsAt'])
  assert.equal(result.lastGood.board.at, EARLY)
  assert.equal(result.lastGood.board.needsAt, EARLY)
  assert.equal(result.lastGood.needsAt, EARLY)
  assert.equal(result.needsAt, EARLY)
  for (const field of BOARD)
    assert.deepEqual(result.lastGood.board.values[field], [{ id: `${field}-a` }])
})

test('a board read with no outcomes connector is still kept as a clean read', () => {
  const result = loader.keepLastGood({ payload: { ...fullPayload(EARLY, 'a'), outcomes: undefined } })
  assert.equal(result.lastGood.board.at, EARLY)
  assert.equal(result.lastGood.board.values.outcomes, undefined)
})

for (const field of BOARD.filter((entry) => entry !== 'projects')) {
  test(`a failed ${field} read puts back the whole board from the same earlier read, never a mix`, () => {
    const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a'), needsReadAt: EARLY })
    const failed = { ...fullPayload(LATE, 'b'), [field]: [], unread: [field] }
    const result = loader.keepLastGood({ payload: failed, lastGood: first.lastGood })
    for (const member of BOARD)
      assert.deepEqual(result.payload[member], [{ id: `${member}-a` }])
    assert.deepEqual(result.payload.unread, [])
    assert.deepEqual(result.stale, { failedAt: LATE, readAt: EARLY })
    assert.equal(result.needsAt, EARLY)
    assert.deepEqual(result.lastGood.board, first.lastGood.board)
  })
}

test('a fresh outcome saying a task is complete never meets the kept board that still shows it open', () => {
  const open = { id: 'wk-1', status: 'open' }
  const first = loader.keepLastGood({
    payload: { ...fullPayload(EARLY, 'a'), linked: [open], outcomes: [{ title: 'wk-1 queued' }] },
  })
  const result = loader.keepLastGood({
    payload: {
      ...fullPayload(LATE, 'b'),
      linked: [],
      outcomes: [{ title: 'wk-1 is complete; no rebuild is pending.' }],
      unread: ['linked'],
    },
    lastGood: first.lastGood,
  })
  assert.deepEqual(result.payload.linked, [open])
  assert.deepEqual(result.payload.outcomes, [{ title: 'wk-1 queued' }])
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
  assert.deepEqual(result.stale, { failedAt: LATE, readAt: EARLY })
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
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a'), needsReadAt: EARLY })
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
  assert.deepEqual(third.stale, { failedAt: LATE, readAt: EARLY })
  assert.equal(third.needsAt, EARLY)
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
  for (const field of BOARD) {
    const payload = deepFreeze({ ...fullPayload(LATE, 'b'), unread: [field] })
    const snapshot = JSON.stringify(payload)
    loader.keepLastGood({ payload, lastGood: first })
    assert.equal(JSON.stringify(payload), snapshot)
    assert.equal(JSON.stringify(first), before)
  }
})

test('the Needs-you clean read time is tracked without any clean board', () => {
  const first = loader.keepLastGood({
    payload: { ...fullPayload(EARLY, 'a'), linked: [], unread: ['linked'] },
    needsReadAt: EARLY,
  })
  assert.equal(first.lastGood.board, undefined)
  assert.equal(first.lastGood.needsAt, EARLY)
  assert.equal(first.needsAt, EARLY)
  const failed = loader.keepLastGood({
    payload: { ...fullPayload(LATE, 'b'), unread: ['projects', 'decisions', 'herSteps', 'linked'] },
    lastGood: first.lastGood,
  })
  assert.equal(failed.lastGood.needsAt, EARLY)
  assert.equal(failed.needsAt, EARLY)
  assert.equal(failed.stale, null)
})

for (const field of ['decisions', 'herSteps']) {
  test(`a ${field} read that has never succeeded leaves no Needs-you read time`, () => {
    const result = loader.keepLastGood({
      payload: { ...fullPayload(EARLY, 'a'), unread: [field] },
    })
    assert.equal(result.needsAt, undefined)
    assert.equal(result.lastGood.needsAt, undefined)
  })
}

test('a clean Needs-you read beside a kept board reports the time of the board it shows', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a'), needsReadAt: EARLY })
  const result = loader.keepLastGood({
    payload: { ...fullPayload(LATE, 'b'), unread: ['linked'] },
    lastGood: first.lastGood,
    needsReadAt: LATE,
  })
  assert.equal(result.lastGood.needsAt, LATE)
  assert.equal(result.needsAt, EARLY)
})

const BOARD_DONE = '2026-11-13T02:43:30.000Z'

test('a clean board with no Needs-you read this refresh leaves the Needs-you time where it was', () => {
  const none = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  assert.equal(none.needsAt, undefined)
  assert.equal(none.lastGood.needsAt, undefined)
  assert.equal(none.lastGood.board.at, EARLY)
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a'), needsReadAt: EARLY })
  const later = loader.keepLastGood({ payload: fullPayload(LATE, 'b'), lastGood: first.lastGood })
  assert.equal(later.needsAt, EARLY)
  assert.equal(later.lastGood.needsAt, EARLY)
  assert.equal(later.lastGood.board.needsAt, EARLY)
})

test('the Needs-you time is the time the Needs-you reads finished, not when the board finished', () => {
  const result = loader.keepLastGood({ payload: fullPayload(BOARD_DONE, 'a'), needsReadAt: EARLY })
  assert.equal(result.needsAt, EARLY)
  assert.equal(result.lastGood.needsAt, EARLY)
  assert.equal(result.lastGood.board.at, BOARD_DONE)
  assert.equal(result.lastGood.board.needsAt, EARLY)
})

test('a kept board reports the Needs-you read time it was taken with, not its own finish time', () => {
  const first = loader.keepLastGood({ payload: fullPayload(BOARD_DONE, 'a'), needsReadAt: EARLY })
  const result = loader.keepLastGood({
    payload: { ...fullPayload(LATE, 'b'), decisions: [], unread: ['decisions'] },
    lastGood: first.lastGood,
  })
  assert.deepEqual(result.stale, { failedAt: LATE, readAt: BOARD_DONE })
  assert.equal(result.needsAt, EARLY)
})

test('a failed rig list puts back the whole earlier board and leaves the Needs-you time alone', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a'), needsReadAt: EARLY })
  const result = loader.keepLastGood({
    payload: { ...fullPayload(LATE, 'b'), unread: ['rigs'] },
    lastGood: first.lastGood,
  })
  for (const member of BOARD)
    assert.deepEqual(result.payload[member], [{ id: `${member}-a` }])
  assert.deepEqual(result.payload.unread, [])
  assert.deepEqual(result.stale, { failedAt: LATE, readAt: EARLY })
  assert.equal(result.needsAt, EARLY)
  assert.equal(result.lastGood.needsAt, EARLY)
})

test('Needs you counts as checked only when a decisions read and a herSteps read both ran cleanly', () => {
  const ok = (key) => ({ key, value: [] })
  const bad = (key) => ({ key, error: 'dolt server restarting' })
  const notRun = (key) => ({ key, error: 'deadline passed', notRun: true })
  assert.equal(loader.needsChecked([]), false)
  assert.equal(loader.needsChecked([ok('decisions')]), false)
  assert.equal(loader.needsChecked([ok('herSteps')]), false)
  assert.equal(loader.needsChecked([ok('decisions'), ok('herSteps'), ok('decisions')]), true)
  assert.equal(loader.needsChecked([ok('decisions'), bad('herSteps')]), false)
  assert.equal(loader.needsChecked([ok('decisions'), ok('herSteps'), bad('decisions')]), false)
  assert.equal(loader.needsChecked([notRun('decisions'), ok('herSteps')]), false)
  assert.equal(loader.needsChecked([ok('decisions'), ok('herSteps'), bad('linked')]), true)
})

test('Nothing needs you is allowed only for a clean read within the last ten minutes', () => {
  assert.equal(loader.NEEDS_CHECK_LIMIT_MS, 10 * 60000)
  const at = (minutes) => Date.parse(EARLY) + minutes * 60000
  assert.equal(loader.needsUnchecked(EARLY, at(0)), null)
  assert.equal(loader.needsUnchecked(EARLY, at(10)), null)
  assert.equal(loader.needsUnchecked(undefined, at(0)), "Couldn't check what needs you yet")
  const since = new Date(EARLY).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  assert.equal(
    loader.needsUnchecked(EARLY, at(11)),
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
