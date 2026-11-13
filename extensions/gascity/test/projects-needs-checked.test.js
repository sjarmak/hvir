const { test } = require('node:test')
const assert = require('node:assert/strict')
const page = require('./stale-page.js')

const { EARLY, livePage, dated, waitingRows, staleLines, workspace } = page
const HOUR = 60
const SECOND = 1000

const decisionRigCalls = (live) =>
  live.bdCalls.filter((args) => args[1] === '/rigs/decisions')

test('with no decisions rig no Needs-you read runs and the pane never says nothing needs you', async (t) => {
  const live = livePage(t)
  const { document } = live
  live.rigs = live.rigs.filter((rig) => rig.name !== 'decisions')
  await live.load()
  assert.equal(decisionRigCalls(live).length, 0)
  const needs = page.needsText(document)
  assert.doesNotMatch(needs, /Nothing needs you/)
  assert.match(needs, /Couldn't check what needs you yet/)
})

test('with no decisions rig an earlier clean check ages out instead of being renewed', async (t) => {
  const live = livePage(t)
  const { document } = live
  await live.load()
  assert.match(page.needsText(document), /Nothing needs you/)
  live.after(48 * HOUR)
  live.rigs = live.rigs.filter((rig) => rig.name !== 'decisions')
  await live.load()
  const needs = page.needsText(document)
  assert.doesNotMatch(needs, /Nothing needs you/)
  assert.match(needs, new RegExp(`Couldn't check what needs you since ${dated(EARLY)}`))
})

test('a rig-list failure 48 hours after a clean load does not say nothing needs you', async (t) => {
  const live = livePage(t)
  const { document } = live
  await live.load()
  live.after(48 * HOUR)
  live.rigListFailing = true
  await live.load()
  assert.match(document.getElementById('status').textContent, /fake rig-list failure/)
  const needs = page.needsText(document)
  assert.doesNotMatch(needs, /Nothing needs you/)
  assert.match(needs, new RegExp(`Couldn't check what needs you since ${dated(EARLY)}`))
})

test('a rig-list failure keeps the earlier board with its waits under the stale warning', async (t) => {
  const live = livePage(t)
  const { document } = live
  await live.load()
  live.after(5)
  live.rigListFailing = true
  await live.load()
  assert.deepEqual(waitingRows(document), ['wk-1'])
  assert.equal(staleLines(document).length, 1)
})

test('a first load whose rig list fails says Needs you has not been checked yet', async (t) => {
  const live = livePage(t)
  const { document } = live
  live.rigListFailing = true
  await live.load()
  assert.equal(decisionRigCalls(live).length, 0)
  assert.match(page.needsText(document), /Couldn't check what needs you yet/)
})

test('a cached view re-shown 601 s after the Needs-you read escalates even though the board finished later', async (t) => {
  const live = livePage(t)
  const { document } = live
  live.during = (args) => {
    if (page.isLabeled(args)) live.clock += 30 * SECOND
  }
  await live.load()
  assert.match(page.needsText(document), /Nothing needs you/)
  live.at(new Date(Date.parse(EARLY) + 601 * SECOND).toISOString())
  live.view.onContext({ workspace: { ...workspace, id: 'elsewhere' } })
  live.view.onContext({ workspace })
  const needs = page.needsText(document)
  assert.doesNotMatch(needs, /Nothing needs you/)
  assert.match(needs, new RegExp(`Couldn't check what needs you since ${dated(EARLY)}`))
})

test('a cached view re-shown 599 s after the Needs-you read still says nothing needs you', async (t) => {
  const live = livePage(t)
  const { document } = live
  live.during = (args) => {
    if (page.isLabeled(args)) live.clock += 30 * SECOND
  }
  await live.load()
  live.at(new Date(Date.parse(EARLY) + 599 * SECOND).toISOString())
  live.view.onContext({ workspace: { ...workspace, id: 'elsewhere' } })
  live.view.onContext({ workspace })
  assert.match(page.needsText(document), /Nothing needs you/)
})
