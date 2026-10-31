const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildDashboard } = require('../projects-model.js')
const { undated, REMOVED } = require('../projects-truth.js')

const NOW = '2026-10-31T16:30:00.000Z'
const project = (meta) => ({ id: 'p', title: 'Project', status: 'open', labels: ['city-project'], store: '/hq',
  metadata: { 'proj.lead': 'city-infra-pl', 'proj.state': 'moving', 'proj.now': 'Work is in flight.',
    'proj.updated_at': '2026-10-31T16:29Z', ...meta } })
const milestone = (id, target, state = 'active', status = 'open') => ({ id, title: `Milestone ${id}`, status,
  parent: 'p', store: '/hq', labels: ['city-milestone'], metadata: { 'ms.state': state, 'ms.target': target } })
const work = (id, status, meta = {}) => ({ id, title: id, status, store: '/hq', metadata: { 'proj.id': 'p', ...meta } })
const ask = (id, meta = {}) => ({ id, title: id, status: 'open', store: '/decisions', labels: ['needs/stephanie'],
  metadata: { 'gc.project': 'p', ...meta } })
const card = (input) => buildDashboard({ now: NOW, sessions: [], ...input }).cards.flatMap((group) => group.cards)[0]

test('other-city faults: open milestones past their due date are flagged and the wait must be named', () => {
  const result = card({ projects: [project({ 'proj.state': 'stuck', 'proj.next_milestone': 'p.1' })],
    milestones: [milestone('p.1', '2026-10-30'), milestone('p.2', '2026-10-31')],
    linked: [work('w1', 'deferred'), work('w2', 'deferred')] })
  assert.deepEqual(result.checks, ['Milestone p.1 is active and its due date 2026-10-30 has passed',
    'Says stuck but names nothing it waits on'])
  assert.equal(result.milestones.next.overdue, true)
  assert.equal(result.milestoneList.find((entry) => entry.id === 'p.2').overdue, false)
  assert.equal(result.derivedState, 'waiting')
})

test('review pipeline: a paused record with only closed work derives no linked work, not paused', () => {
  const result = card({ projects: [project({ 'proj.state': 'paused', 'proj.next_milestone': 'p.3' })],
    milestones: [milestone('p.3', '2026-10-30', 'planned')], linked: [] })
  assert.equal(result.derivedState, 'no-linked-work')
  assert.equal(result.state, 'paused')
  assert.deepEqual(result.checks, ['Milestone p.3 is planned and its due date 2026-10-30 has passed',
    'Says paused but names nothing it waits on'])
  assert.deepEqual(result.actionOwner, { kind: 'agent', name: 'city-infra-pl' })
})

test('review-pipeline eval: a stated wait on her with no decision linked is a contradiction, not a need', () => {
  const result = card({ projects: [project({ 'proj.state': 'paused', 'proj.waiting_on': 'stephanie' })], linked: [] })
  assert.equal(result.needsCount, 0)
  assert.deepEqual(result.checks, ['Says it waits on Stephanie but no decision of hers is linked'])
  assert.deepEqual(result.actionOwner, { kind: 'agent', name: 'city-infra-pl' })
})

test('dashboard: an answered decision with her step left counts as needs you and makes her the action owner', () => {
  const herStep = ask('dec-d', { 'gc.answered': '2026-10-31', 'gc.waiting_on': 'stephanie', 'gc.her_step': 'Click Connect.' })
  const model = buildDashboard({ now: NOW, sessions: [], decisions: [herStep],
    projects: [project({ 'proj.state': 'stuck', 'proj.waiting_on': 'dec-d', 'proj.receipt_at': '2026-10-31T12:58Z' })] })
  const result = model.cards[0].cards[0]
  assert.equal(result.needsCount, 1)
  assert.deepEqual(model.needsYou.map((entry) => entry.id), ['dec-d'])
  assert.deepEqual(model.inDelivery, [])
  assert.deepEqual(result.actionOwner, { kind: 'user', name: 'Stephanie' })
  assert.equal(result.derivedState, 'needs-you')
  assert.deepEqual(result.checks, [])
  assert.equal(result.verifiedAt, '2026-10-31T12:58Z')
  assert.equal(result.fetchedAt, NOW)
})

test('fair scoring: needs you that names only an answered decision with nothing of hers left is flagged', () => {
  const done = ask('dec-a', { 'gc.answered': '2026-10-30' })
  const result = card({ decisions: [done], projects: [project({ 'proj.state': 'needs-you', 'proj.waiting_on': 'dec-a' })] })
  assert.equal(result.needsCount, 0)
  assert.deepEqual(result.checks, ['Says it needs you but names no decision of hers',
    'dec-a is answered with no step of hers left; name the work that delivers it'])
})

test('new task types: an unnamed open decision of hers and a named wait that already closed are both flagged', () => {
  const open = ask('dec-q')
  const result = card({ decisions: [open], linked: [work('w-done', 'closed')],
    projects: [project({ 'proj.waiting_on': 'w-done' })] })
  assert.equal(result.needsCount, 1)
  assert.deepEqual(result.checks, ['dec-q waits on Stephanie but the card does not name it',
    'w-done is named as a wait but is closed'])
  const foreign = card({ projects: [project({ 'proj.waiting_on': 'om-elsewhere' })] })
  assert.deepEqual(foreign.checks, ['om-elsewhere is named as a wait but is not linked to this project'])
})

test('every date on a card carries a reason, and the record write time is not one of them', () => {
  const result = card({ projects: [project({ 'proj.next_milestone': 'p.1', 'proj.waiting_on': 'w1',
    'proj.receipt_at': '2026-10-31T15:00Z' })], milestones: [milestone('p.1', '2026-11-03')],
  linked: [work('w1', 'deferred', { 'gc.owner': 'pip' }), { ...work('w2', 'blocked'), defer_until: '2026-11-02T14:00:00Z' }] })
  const reasons = new Set(['deadline', 'dependency', 'evidence-check'])
  assert.equal(result.dates.every((entry) => reasons.has(entry.reason)), true)
  assert.deepEqual(result.dates.map((entry) => [entry.label, entry.reason]), [
    ['Due: Milestone p.1', 'deadline'], ['Last verified progress', 'evidence-check'], ['Fetched', 'evidence-check']])
  assert.equal(result.dates.some((entry) => entry.at === '2026-10-31T16:29Z'), false)
  assert.deepEqual(result.actionOwner, { kind: 'dot', name: 'Pip' })
})

test('a named wait with a defer date shows it as a dependency', () => {
  const result = card({ projects: [project({ 'proj.waiting_on': 'w2' })],
    linked: [{ ...work('w2', 'deferred', { 'gc.owner': 'gascity-pl' }), defer_until: '2026-11-02T14:00:00Z' }] })
  assert.deepEqual(result.dates[0], { label: 'Waits until: w2', at: '2026-11-02T14:00:00Z', reason: 'dependency', overdue: false })
  assert.deepEqual(result.actionOwner, { kind: 'agent', name: 'gascity-pl' })
})

test('dates inside lead prose are removed because no record supports them', () => {
  assert.equal(undated('Chased 2026-10-31T16:30Z, again at 17:38Z, then on 2026-11-03.'),
    `Chased ${REMOVED}, again at ${REMOVED}, then on ${REMOVED}.`)
  assert.equal(undated('Three PRs, issue #68966, version 0.166.0'), 'Three PRs, issue #68966, version 0.166.0')
  const result = card({ projects: [project({ 'proj.now': 'Fixed 2026-10-31T16:30Z.', 'proj.blocker': 'Waits to 18:00Z.' })] })
  assert.equal(result.now, `Fixed ${REMOVED}.`)
  assert.equal(result.blocker, `Waits to ${REMOVED}.`)
})

test('fetched time and last verified progress are separate, and a refreshed record time moves neither', () => {
  const base = card({ projects: [project({ 'proj.receipt_at': '2026-10-30T09:00Z' })] })
  const touched = card({ projects: [project({ 'proj.receipt_at': '2026-10-30T09:00Z', 'proj.updated_at': '2026-10-31T16:30Z' })] })
  assert.equal(base.verifiedAt, '2026-10-30T09:00Z')
  assert.equal(touched.verifiedAt, base.verifiedAt)
  assert.equal(touched.fetchedAt, NOW)
  assert.equal(card({ projects: [project({})] }).verifiedAt, null)
})
