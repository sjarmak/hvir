const { test } = require('node:test')
const assert = require('node:assert/strict')
const page = require('./stale-page.js')

const { EARLY, livePage, clock, dated, chipOf, waitingRows, staleLine, staleLines } = page
const LATE = '2026-11-13T02:48:00.000Z'
const HOUR = 60

const reads = {
  linked: page.isLinked,
  inProgress: page.isInProgress,
  urgent: page.isUrgent,
  decisions: page.isDecisions,
  herSteps: page.isHerSteps,
}

for (const [name, failing] of Object.entries(reads)) {
  test(`a refresh whose ${name} read fails keeps the cards and Waiting on, and says what time it shows`, async (t) => {
    const live = livePage(t)
    const { document } = live
    await live.load()
    const before = { chip: chipOf(document), waiting: waitingRows(document) }
    assert.equal(before.chip, 'waiting')
    assert.deepEqual(before.waiting, ['wk-1'])
    assert.equal(staleLine(document), null)
    live.at(LATE)
    live.failing = failing
    await live.load()
    assert.equal(chipOf(document), before.chip)
    assert.deepEqual(waitingRows(document), before.waiting)
    const line = staleLine(document)
    assert.ok(line.classList.contains('projects-warning'))
    assert.equal(
      line.textContent,
      `Couldn't refresh at ${clock(LATE)}; showing what was read at ${clock(EARLY)}`,
    )
  })
}

test('a first load whose linked read fails shows the cards as unread with no stale line', async (t) => {
  const live = livePage(t)
  const { document } = live
  live.failing = page.isLinked
  await live.load()
  assert.equal(chipOf(document), 'unread')
  assert.deepEqual(waitingRows(document), [])
  assert.equal(staleLine(document), null)
})

test('a good refresh after a failed one removes the stale line and shows the new read', async (t) => {
  const live = livePage(t)
  const { document } = live
  await live.load()
  live.at(LATE)
  live.failing = page.isLinked
  await live.load()
  assert.ok(staleLine(document))
  live.at('2026-11-13T02:50:00.000Z')
  live.failing = () => false
  live.projects = [
    {
      ...live.projects[0],
      metadata: { ...live.projects[0].metadata, 'proj.waiting_on': 'none' },
    },
  ]
  await live.load()
  assert.equal(staleLine(document), null)
  assert.equal(chipOf(document), 'queued')
})

for (const [name, failing] of [
  ['decisions', page.isDecisions],
  ['herSteps', page.isHerSteps],
]) {
  test(`a ${name} read failing for over ten minutes stops saying nothing needs you, with the date`, async (t) => {
    const live = livePage(t)
    const { document } = live
    await live.load()
    assert.match(page.needsText(document), /Nothing needs you/)
    live.failing = failing
    live.after(10)
    await live.load()
    assert.match(page.needsText(document), /Nothing needs you/)
    for (const hours of [1, 6, 48]) {
      live.after(hours * HOUR)
      await live.load()
      const needs = page.needsText(document)
      assert.doesNotMatch(needs, /Nothing needs you/)
      assert.match(
        needs,
        new RegExp(`Couldn't check what needs you since ${dated(EARLY)}`),
      )
    }
    const now = new Date(Date.parse(EARLY) + 48 * HOUR * 60000).toISOString()
    assert.equal(
      staleLine(document).textContent,
      `Couldn't refresh at ${clock(now)}; showing what was read at ${dated(EARLY)}`,
    )
    live.failing = () => false
    live.after(49 * HOUR)
    await live.load()
    assert.equal(staleLine(document), null)
    assert.match(page.needsText(document), /Nothing needs you/)
    assert.doesNotMatch(page.needsText(document), /Couldn't check/)
  })
}

test('when every project-list read fails the kept cards still carry the stale warning', async (t) => {
  const live = livePage(t)
  const { document } = live
  await live.load()
  live.at(LATE)
  live.failing = page.isLabeled
  await live.load()
  assert.equal(chipOf(document), 'waiting')
  assert.equal(staleLines(document).length, 1)
  assert.equal(
    staleLine(document).textContent,
    `Couldn't refresh at ${clock(LATE)}; showing what was read at ${clock(EARLY)}`,
  )
})

test('a project-list failure with a fresh Needs-you read does not claim the Needs-you check is unknown', async (t) => {
  const live = livePage(t)
  const { document } = live
  await live.load()
  live.after(48 * HOUR)
  live.failing = page.isLabeled
  await live.load()
  assert.equal(staleLines(document).length, 1)
  assert.match(page.needsText(document), /Nothing needs you/)
  assert.doesNotMatch(page.needsText(document), /Couldn't check/)
})

test('a deleted project whose linked read fails keeps the project with its waits, not orphan rows', async (t) => {
  const live = livePage(t)
  const { document } = live
  await live.load()
  assert.equal(page.navRows(document), 1)
  live.at(LATE)
  live.projects = []
  live.failing = page.isLinked
  await live.load()
  assert.equal(page.navRows(document), 1)
  assert.deepEqual(waitingRows(document), ['wk-1'])
})

test('a task blocked in a fresh linked read with a failing in-progress read keeps the earlier coherent card', async (t) => {
  const live = livePage(t)
  const { document } = live
  const work = (status, title) => ({
    id: 'wk-2',
    title,
    status,
    priority: 1,
    assignee: 'lead-a',
    updated_at: new Date(live.clock).toISOString(),
    metadata: { 'proj.id': 'pj-1' },
  })
  live.projects = [
    {
      ...live.projects[0],
      metadata: { ...live.projects[0].metadata, 'proj.waiting_on': 'wk-2' },
    },
  ]
  live.linked = () => [work('in_progress', 'Ship the index')]
  live.inProgress = () => [work('in_progress', 'Ship the index')]
  await live.load()
  const before = chipOf(document)
  assert.equal(before, 'moving')
  live.at(LATE)
  live.linked = () => [work('blocked', 'Ship the index, blocked on review')]
  live.failing = page.isInProgress
  await live.load()
  assert.equal(chipOf(document), before)
  assert.match(document.body.textContent, /Ship the index/)
  assert.doesNotMatch(document.body.textContent, /blocked on review/)
  assert.ok(staleLine(document))
})

test('an answered decision is not shown beside the step that followed it while decisions fail', async (t) => {
  const live = livePage(t)
  const { document } = live
  live.asks = [
    {
      id: 'dec-1',
      title: 'Pick a name',
      status: 'open',
      labels: ['needs/stephanie'],
      metadata: { 'gc.project': 'pj-1' },
    },
  ]
  await live.load()
  assert.match(page.needsText(document), /Pick a name/)
  live.at(LATE)
  live.asks = []
  live.steps = [
    {
      id: 'dec-2',
      title: 'Approve the name',
      status: 'open',
      labels: ['needs/stephanie-step'],
      metadata: { 'gc.her_step': 'Approve the name' },
    },
  ]
  live.failing = page.isDecisions
  await live.load()
  assert.match(page.needsText(document), /Pick a name/)
  assert.doesNotMatch(page.stepsText(document), /Approve the name/)
})

test('the card-text record om-p86nj8 still names Waiting on rows through a kept read', async (t) => {
  const live = livePage(t)
  const { document } = live
  live.artifacts = [
    {
      id: 'om-p86nj8',
      title: 'Card texts',
      status: 'open',
      labels: ['city-artifact'],
      metadata: {
        'gc.card_texts': JSON.stringify({ 'wk-1': 'Rebuild the lantern index' }),
      },
    },
  ]
  await live.load()
  assert.match(document.body.textContent, /Rebuild the lantern index/)
  live.at(LATE)
  live.failing = page.isLinked
  await live.load()
  assert.match(document.body.textContent, /Rebuild the lantern index/)
  assert.ok(staleLine(document))
})

const outcome = (text) => ({
  time: EARLY,
  title: 'Index rebuild',
  outcome: text,
  projects: ['pj-1'],
})

test('a fresh outcome never sits beside a kept board it contradicts', async (t) => {
  const live = livePage(t, { entry: 'project' })
  const { document } = live
  live.outcomes = [outcome('Rebuild of wk-1 queued.')]
  await live.load()
  assert.deepEqual(waitingRows(document), ['wk-1'])
  assert.match(document.body.textContent, /Rebuild of wk-1 queued/)
  live.at(LATE)
  live.outcomes = [outcome('wk-1 is complete; no rebuild is pending.')]
  live.failing = page.isLinked
  await live.load()
  assert.deepEqual(waitingRows(document), ['wk-1'])
  assert.match(document.body.textContent, /Rebuild of wk-1 queued/)
  assert.doesNotMatch(document.body.textContent, /wk-1 is complete/)
  assert.ok(staleLine(document))
})

test('a failing outcomes read keeps the whole board from the same earlier read', async (t) => {
  const live = livePage(t, { entry: 'project' })
  const { document } = live
  live.outcomes = [outcome('Rebuild of wk-1 queued.')]
  await live.load()
  live.at(LATE)
  live.linked = () => []
  live.outcomesFailing = true
  await live.load()
  assert.deepEqual(waitingRows(document), ['wk-1'])
  assert.match(document.body.textContent, /Rebuild of wk-1 queued/)
  assert.equal(
    staleLine(document).textContent,
    `Couldn't refresh at ${clock(LATE)}; showing what was read at ${clock(EARLY)}`,
  )
})

const everyRead = () => true

test('with no clean board ever, Needs you still escalates once every read fails for 48 hours', async (t) => {
  const live = livePage(t)
  const { document } = live
  live.failing = page.isLinked
  await live.load()
  assert.match(page.needsText(document), /Nothing needs you/)
  live.after(48 * HOUR)
  live.failing = everyRead
  await live.load()
  const needs = page.needsText(document)
  assert.doesNotMatch(needs, /Nothing needs you/)
  assert.match(needs, new RegExp(`Couldn't check what needs you since ${dated(EARLY)}`))
  assert.equal(staleLines(document).length, 1)
})

test('with no clean board, a decisions read failing for an hour names the last clean Needs-you read', async (t) => {
  const live = livePage(t)
  const { document } = live
  live.failing = page.isLinked
  await live.load()
  live.after(HOUR)
  live.failing = (args) => page.isLinked(args) || page.isDecisions(args)
  await live.load()
  const needs = page.needsText(document)
  assert.doesNotMatch(needs, /Nothing needs you/)
  assert.match(needs, new RegExp(`Couldn't check what needs you since ${dated(EARLY)}`))
})

for (const [name, failing] of [
  ['decisions', page.isDecisions],
  ['herSteps', page.isHerSteps],
]) {
  test(`a first load whose ${name} read fails says Needs you has not been checked yet`, async (t) => {
    const live = livePage(t)
    const { document } = live
    live.failing = failing
    await live.load()
    const needs = page.needsText(document)
    assert.doesNotMatch(needs, /Nothing needs you/)
    assert.match(needs, /Couldn't check what needs you yet/)
  })
}
