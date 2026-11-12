const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const { parseRefs, buildDashboard } = require('../projects-model.js')
const fixture = require('./fixtures/projects-dashboard.json')

const fresh = () => structuredClone(fixture)
const cards = (model) => model.cards.flatMap((group) => group.cards)
const card = (model, id = 'fx-project-1') => cards(model).find((entry) => entry.id === id)
const activities = (model) => model.activeNow.flatMap((group) => group.items)
const activity = (model, name) => activities(model).find((entry) => entry.session === name)
const projectFor = (model, name) => model.activeNow.find((group) =>
  group.items.some((entry) => entry.session === name))?.project

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

test('parseRefs parses contract syntax and preserves every invalid entry', () => {
  assert.deepEqual(parseRefs('fake-owner/repo.name_1#12,A_B/r-2#1'), {
    refs: [
      { owner: 'fake-owner', repo: 'repo.name_1', number: 12, key: 'fake-owner/repo.name_1#12' },
      { owner: 'A_B', repo: 'r-2', number: 1, key: 'A_B/r-2#1' },
    ],
    invalid: [],
  })
  const invalid = ['bad', 'o/r#0', 'o/r#01', 'o/r#-1', 'o/r#1.5', 'o/r#1 ',
    ' o/r#1', 'ø/r#1', 'o/r/x#1', 'o/r#1\n', '']
  assert.deepEqual(parseRefs(invalid.join(',')), { refs: [], invalid })
  assert.equal(parseRefs('o/r#1,bad,o/r#2').refs.length, 2)
  assert.equal(parseRefs('o/r#9007199254740992').refs[0].key, 'o/r#9007199254740992')
  assert.deepEqual(parseRefs('o/r#1,bad,o/r#2').invalid, ['bad'])
})

test('parseRefs treats absent fields as empty and reports wrong types', () => {
  for (const value of [undefined, null, '']) assert.deepEqual(parseRefs(value), { refs: [], invalid: [] })
  assert.deepEqual(parseRefs(42), { refs: [], invalid: [42] })
})

test('fixture browser script matches the JSON source exactly', () => {
  const source = readFileSync(`${__dirname}/fixtures/projects-dashboard.js`, 'utf8')
  const sandbox = { window: {} }
  vm.runInNewContext(source, sandbox)
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.projectsFixture)), fixture)
  const modelSandbox = { window: {} }
  vm.runInNewContext(readFileSync(`${__dirname}/../projects-model.js`, 'utf8'), modelSandbox)
  assert.equal(Object.isFrozen(modelSandbox.window.projectsModel), true)
})

test('dashboard is pure, groups six projects under three leads, and keeps cross-seat work once', () => {
  const input = deepFreeze(fresh())
  const before = JSON.stringify(input)
  const model = buildDashboard(input)
  assert.equal(JSON.stringify(input), before)
  assert.deepEqual(model.cards.map((group) => group.lead), ['omni-pl', 'omni-evals-pl', 'city-infra-pl'])
  assert.equal(cards(model).length, 6)
  assert.equal(cards(model).filter((entry) => entry.id === 'fx-project-3').length, 1)
  assert.deepEqual(card(model, 'fx-project-3').contributors, ['omni-pl', 'omni-evals-pl'])
  assert.deepEqual(new Set(cards(model).map((entry) => entry.state)),
    new Set(['moving', 'stuck', 'needs-you', 'paused', 'done']))
  assert.equal(card(model).title, 'Lantern catalog')
  assert.equal(card(model).now, input.projects[0].metadata['proj.now'])
  assert.equal(card(model, 'fx-project-2').stuckWhy, input.projects[1].metadata['proj.stuck_why'])
  assert.equal(card(model, 'fx-project-4').stale, true)
})

test('needs you matches open labelled unanswered asks and resolves only gc.project', () => {
  const input = fresh()
  input.decisions.push(
    { id: 'fx-closed', status: 'closed', labels: ['needs/stephanie'] },
    { id: 'fx-working', status: 'in_progress', labels: ['needs/stephanie'] },
    { id: 'fx-unlabelled', status: 'open' },
    { id: 'fx-case', status: 'open', labels: ['Needs/Stephanie'], metadata: { 'gc.answered': '' } },
  )
  const model = buildDashboard(input)
  assert.deepEqual(model.needsYou.map((ask) => ask.id), ['fx-ask-retention', 'fx-ask-unlinked', 'fx-case'])
  assert.deepEqual(model.needsYou[0].project, { id: 'fx-project-3', title: 'Shared signal board' })
  assert.equal(model.needsYou[1].project, null)
  assert.equal(model.needsYou[0].refs.issues[0].state, 'open')
  assert.equal(card(model, 'fx-project-3').needsCount, 1)
  assert.equal(card(model).needsCount, 0)
  assert.equal(card(model).decisions[0].id, 'fx-ask-answered')
})

test('missing optional metadata and missing project state remain visible', () => {
  const model = buildDashboard({ now: fixture.now, projects: [{ id: 'fx-broken', title: 'Incomplete project' }] })
  const broken = cards(model)[0]
  assert.equal(broken.state, 'unknown')
  assert.equal(broken.updatedAt, null)
  assert.equal(broken.stale, true)
  assert.deepEqual(broken.contributors, [])
  assert.equal(broken.milestones.next, null)
  assert.deepEqual(buildDashboard({ now: fixture.now }).activeNow, [])
})

test('staleness uses project metadata with strict 24h boundary and done exemption', () => {
  for (const [updated, state, stale] of [
    ['2026-10-28T12:00Z', 'moving', false],
    ['2026-10-28T11:59Z', 'moving', true],
    ['2026-10-30T12:00Z', 'moving', false],
    ['2026-10-01T12:00Z', 'done', false],
  ]) {
    const input = fresh()
    input.projects[0].metadata['proj.updated_at'] = updated
    input.projects[0].metadata['proj.state'] = state
    input.projects[0].updated_at = '2000-01-01T00:00:00Z'
    assert.equal(card(buildDashboard(input)).stale, stale)
    assert.equal(card(buildDashboard(input)).updatedAt, updated)
  }
})

test('milestones sort by target, exclude dropped from totals, retain outcomes and named next', () => {
  const input = fresh()
  const dropped = input.milestones.find((entry) => entry.id === 'fx-ms-8')
  delete dropped.parent
  dropped.dependencies = [{ type: 'parent-child', depends_on_id: 'fx-project-1' },
    { type: 'parent-child', id: 'fx-project-1' }]
  const result = card(buildDashboard(input))
  assert.deepEqual(result.milestones, { done: 1, total: 2,
    next: { id: 'fx-ms-1', title: 'Searchable catalog', target: '2026-11-02', targetReason: '', state: 'active',
      overdue: false } })
  assert.deepEqual(result.milestoneList.map((entry) => entry.state), ['done', 'dropped', 'active'])
  assert.equal(result.milestoneList[0].outcome, 'A synthetic baseline was delivered.')
})

test('refs join states by key, preserve invalid input, and deduplicate repeated milestone refs', () => {
  const result = card(buildDashboard(fresh()))
  assert.equal(result.refs.prs.length, 1)
  assert.deepEqual(result.refs.prs[0], { owner: 'fixture-lab', repo: 'lantern', number: 12,
    key: 'fixture-lab/lantern#12', state: 'draft', review: 'pending', checks: 'passing',
    title: 'Add synthetic catalog search' })
  assert.deepEqual(result.refs.invalid, ['bad reference'])
  assert.equal(result.refs.issues[0].state, 'open')
})

test('sessions join assignees by id, name, or agent_name, once even with duplicate input', () => {
  for (const assignee of ['fx-session-lead', 'omni-pl', 'fx-lead-agent']) {
    const input = fresh()
    input.sessions[0].agent_name = 'fx-lead-agent'
    input.inProgress[0].assignee = assignee
    input.sessions.push(structuredClone(input.sessions[0]))
    const model = buildDashboard(input)
    const lead = activity(model, 'omni-pl')
    assert.deepEqual(lead.bead, { id: 'fx-lead-work', title: 'Shape the catalog launch' })
    assert.equal(lead.agent, 'fx-lead-agent')
    assert.equal(projectFor(model, 'omni-pl').id, 'fx-project-1')
    assert.equal(activities(model).filter((entry) => entry.session === 'omni-pl').length, 1)
    assert.equal(card(model).active.length, 2)
  }
})

test('unassigned sessions stay visible, with no keyword or title inference', () => {
  const input = fresh()
  input.sessions[3].name = 'Lantern catalog'
  input.inProgress[0].status = 'open'
  const model = buildDashboard(input)
  const unlinked = model.activeNow.find((group) => group.project === null)
  assert.equal(unlinked.label, 'No project')
  assert.equal(activity(model, 'Lantern catalog').bead, null)
  assert.equal(activity(model, 'omni-pl').bead, null)
  assert.equal(activity(model, 'Lantern catalog').workflow, null)
  assert.equal(projectFor(model, 'Lantern catalog'), null)
})

test('workflow metadata joins root, current step and closed-only progress', () => {
  const model = buildDashboard(fresh())
  const worker = activity(model, 'fx-worker-a')
  assert.deepEqual(worker.workflow, { rootId: 'fx-root-catalog', formula: 'mol-scoped-work',
    step: 'implement', stepsDone: 1, stepsTotal: 2 })
  assert.equal(projectFor(model, 'fx-worker-a').id, 'fx-project-1')
  assert.deepEqual(card(model).workflows[0].running, [{ session: 'fx-worker-a', step: 'implement' }])
  assert.equal(card(model).workflows[0].stepsDone, 1)
  assert.equal(activity(model, 'fx-worker-b').workflow.formula, 'mol-scoped-work')
})

test('project resolution walks parents and workflow-root parents without heuristics', () => {
  const input = fresh()
  assert.equal(projectFor(buildDashboard(input), 'fx-worker-b').id, 'fx-project-2')
  delete input.inProgress[2].parent
  assert.equal(projectFor(buildDashboard(input), 'fx-worker-b').id, 'fx-project-2')
  input.workflowRoots[1].metadata['gc.kind'] = 'ordinary'
  assert.equal(projectFor(buildDashboard(input), 'fx-worker-b'), null)
  assert.equal(activity(buildDashboard(input), 'fx-worker-b').workflow, null)
})

test('expanded parent-child dependencies join a milestone and a bead to the project', () => {
  const project = { id: 'fx-p', title: 'P', metadata: { 'proj.state': 'moving', 'proj.updated_at': fixture.now } }
  const edge = { dependency_type: 'parent-child', id: 'fx-p' }
  const model = buildDashboard({
    now: fixture.now,
    projects: [project],
    milestones: [{ id: 'fx-m', title: 'M', dependencies: [edge], metadata: { 'ms.state': 'active', 'ms.target': '2026-11-01' } }],
    inProgress: [{ id: 'fx-b', title: 'B', status: 'in_progress', assignee: 'fx-s', dependencies: [edge] }],
    sessions: [{ id: 'fx-s', name: 'fx-s' }],
  })
  assert.equal(card(model, 'fx-p').milestones.total, 1)
  assert.equal(projectFor(model, 'fx-s').id, 'fx-p')
})

test('a project with a future or unparseable timestamp follows the 24h rule only when parseable', () => {
  const input = fresh()
  input.projects[0].metadata['proj.state'] = 'moving'
  input.projects[0].metadata['proj.updated_at'] = '2099-01-01T00:00Z'
  assert.equal(card(buildDashboard(input)).stale, false)
  input.projects[0].metadata['proj.updated_at'] = 'yesterday'
  assert.equal(card(buildDashboard(input)).stale, true)
})

test('direct project metadata wins over root and parent links', () => {
  const input = fresh()
  input.inProgress[1].metadata['proj.id'] = 'fx-project-3'
  assert.equal(projectFor(buildDashboard(input), 'fx-worker-a').id, 'fx-project-3')
  input.inProgress[1].metadata['proj.id'] = 'fx-missing'
  assert.equal(projectFor(buildDashboard(input), 'fx-worker-a'), null)
})

test('cycles and dangling parent chains terminate with no project', () => {
  const input = fresh()
  input.workflowRoots[1].parent = 'fx-step-replay'
  input.inProgress[2].parent = 'fx-root-replay'
  assert.equal(projectFor(buildDashboard(input), 'fx-worker-b'), null)
  input.inProgress[2].parent = 'fx-missing'
  input.workflowRoots[1].parent = 'fx-missing'
  assert.equal(projectFor(buildDashboard(input), 'fx-worker-b'), null)
})

test('only alive seat jobs join their bead and project, preserving model, account and start', () => {
  const model = buildDashboard(fresh())
  const jobs = activities(model).filter((entry) => entry.kind === 'seat-job')
  assert.equal(jobs.length, 1)
  assert.deepEqual(jobs[0].bead, { id: 'fx-seat-work', title: 'Check retention choices' })
  assert.equal(jobs[0].model, 'gpt-fixture')
  assert.equal(jobs[0].account, 'fx-review-account')
  assert.equal(jobs[0].startedAt, '2026-10-29T10:00Z')
  assert.equal(projectFor(model, jobs[0].session).id, 'fx-project-3')
  const input = fresh()
  input.seatJobs[0].job.bead = 'fx-step-replay'
  assert.equal(projectFor(buildDashboard(input), jobs[0].session).id, 'fx-project-2')
})

test('session model parses command arguments and otherwise uses the provider', () => {
  const input = fresh()
  const original = buildDashboard(input)
  assert.equal(activity(original, 'omni-pl').model, 'gpt-fixture')
  assert.equal(activity(original, 'fx-worker-b').model, 'claude')
  assert.equal(activity(original, 'omni-pl').startedAt, '2026-10-29T09:00Z')
  for (const command of ['codex --model "fixture model"', "codex --model 'fixture model'", ['codex', '--model', 'fixture model']]) {
    input.sessions[0].command = command
    assert.equal(activity(buildDashboard(input), 'omni-pl').model, 'fixture model')
  }
})

test('parent-only work can reach a project directly, and linked workflows remain when inactive', () => {
  const input = fresh()
  delete input.inProgress[2].metadata['gc.root_bead_id']
  const model = buildDashboard(input)
  assert.equal(projectFor(model, 'fx-worker-b').id, 'fx-project-2')
  assert.equal(activity(model, 'fx-worker-b').workflow, null)
  const idle = buildDashboard({ ...input, sessions: [], seatJobs: [] })
  assert.equal(card(idle).workflows.length, 1)
  assert.deepEqual(card(idle).workflows[0].running, [])
})

test('unlinked alive seat jobs and unknown decision projects remain visible', () => {
  const input = fresh()
  input.seatJobs[0].job.bead = 'fx-missing'
  input.decisions[0].metadata['gc.project'] = 'fx-missing'
  const model = buildDashboard(input)
  assert.equal(model.needsYou[0].project, null)
  const unlinked = model.activeNow.find((group) => group.project === null)
  assert.equal(unlinked.items.length, 2)
  assert.equal(unlinked.items.find((item) => item.kind === 'seat-job').bead, null)
})

test('workflow totals count every linked step but only closed steps are done', () => {
  const input = fresh()
  input.workflowSteps.push({ id: 'fx-blocked', status: 'blocked',
    metadata: { 'gc.root_bead_id': 'fx-root-catalog', 'gc.step_id': 'verify' } })
  const result = activity(buildDashboard(input), 'fx-worker-a').workflow
  assert.equal(result.stepsTotal, 3)
  assert.equal(result.stepsDone, 1)
  const missing = fresh()
  missing.refStates = {}
  assert.equal(card(buildDashboard(missing)).refs.prs[0].key, 'fixture-lab/lantern#12')
})

test('duplicate project ids across stores are reported, not silently merged', () => {
  const { duplicateProjects } = require('../projects-model.js')
  assert.deepEqual(duplicateProjects([{ id: 'a', store: '/x' }, { id: 'a', store: '/y' }, { id: 'b', store: '/x' }, { id: 'b', store: '/x' }]), ['a'])
  assert.deepEqual(duplicateProjects(), [])
})

test('a card lists its in-progress beads, joined by the same rules as Active now', () => {
  const model = buildDashboard(fresh())
  for (const entry of cards(model)) {
    const titles = entry.inProgress.map((bead) => bead.title).sort()
    const active = entry.active.map((item) => item.bead?.title).filter(Boolean)
    for (const title of active.filter((name) => !titles.includes(name))) {
      assert.ok(entry.active.find((item) => item.bead?.title === title).kind === 'seat-job', title)
    }
  }
  assert.ok(cards(model).some((entry) => entry.inProgress.length > 0))
})

test('outcome history joins by listed project id and is off until outcomes are supplied', () => {
  const input = fresh()
  assert.equal(buildDashboard(input).outcomesShown, false)
  assert.deepEqual(card(buildDashboard(input)).outcomes, [])
  input.outcomes = [
    { time: '2026-10-29T03:00Z', title: 'Both', outcome: 'o1', projects: ['fx-project-1', 'fx-project-2'] },
    { time: '2026-10-28T03:00Z', title: 'Other', outcome: '', projects: ['fx-project-3'] },
  ]
  const model = buildDashboard(input)
  assert.equal(model.outcomesShown, true)
  assert.deepEqual(card(model, 'fx-project-1').outcomes.map((entry) => entry.title), ['Both'])
  assert.deepEqual(card(model, 'fx-project-2').outcomes.map((entry) => entry.title), ['Both'])
  assert.deepEqual(card(model, 'fx-project-3').outcomes.map((entry) => entry.title), ['Other'])
})

test('answered open asks are counted as in delivery and each card decision says whether it needs her', () => {
  const model = buildDashboard(fresh())
  assert.equal(model.inDelivery.length, 1)
  assert.equal(model.inDelivery[0].id, 'fx-ask-answered')
  assert.deepEqual(card(model).decisions.map((ask) => [ask.id, ask.needsYou]), [['fx-ask-answered', false]])
  assert.deepEqual(card(model, 'fx-project-3').decisions.map((ask) => [ask.id, ask.needsYou]), [['fx-ask-retention', true]])
})

test('a card carries the stored blocker, next action and each artifact state with its source and freshness', () => {
  const project = card(buildDashboard(fresh()))
  assert.equal(project.blocker, 'Waiting on the catalog index rebuild.')
  assert.equal(project.nextAction, 'omni-pl reruns the import once the index is back.')
  assert.deepEqual(project.artifacts.map((entry) => entry.id), ['fx-art-1', 'fx-art-2'])
  const [current, old] = project.artifacts
  assert.equal(current.kind, 'repo-head')
  assert.equal(current.ref, 'fixture-lab/lantern@abc1234')
  assert.deepEqual(current.states.map((state) => [state.name, state.claimed, state.stale]),
    [['tested', true, false], ['installed', true, true], ['live', false, false]])
  assert.deepEqual(current.states[0], { name: 'tested', claimed: true, at: '2026-10-29T09:00Z',
    source: 'node --test test/*.test.js', checkedAt: '2026-10-29T11:00Z', stale: false })
  assert.equal(old.closed, true)
  assert.equal(old.states.find((state) => state.name === 'live').stale, false)
})

test('artifact freshness ends when the project is done and other projects get none of its artifacts', () => {
  const input = fresh()
  input.projects[0].metadata['proj.state'] = 'done'
  const model = buildDashboard(input)
  assert.equal(card(model).artifacts[0].states.some((state) => state.stale), false)
  assert.equal(cards(model).filter((entry) => entry.id !== 'fx-project-1')
    .every((entry) => entry.artifacts.length === 0 && entry.blocker === '' && entry.nextAction === ''), true)
})

test('artifacts and milestones join only to a project in their own store', () => {
  const input = fresh()
  for (const key of ['projects', 'milestones', 'artifacts']) for (const bead of input[key]) bead.store = '/rigs/a'
  input.artifacts.push({ ...structuredClone(input.artifacts[0]), id: 'fx-art-other', store: '/rigs/b' })
  input.milestones.push({ ...structuredClone(input.milestones[0]), id: 'fx-ms-other', store: '/rigs/b',
    metadata: { ...input.milestones[0].metadata, 'ref.prs': 'fixture-lab/foreign#99' } })
  const project = card(buildDashboard(input))
  assert.deepEqual(project.artifacts.map((entry) => entry.id), ['fx-art-1', 'fx-art-2'])
  assert.equal(project.milestoneList.some((entry) => entry.id === 'fx-ms-other'), false)
  assert.equal(project.refs.prs.some((ref) => ref.key === 'fixture-lab/foreign#99'), false)
})

test('artifact freshness: exactly 24h is fresh, a minute more is stale, a missing check time is unknown, not stale', () => {
  const input = fresh()
  const meta = input.artifacts[0].metadata
  const stateOf = (name) => card(buildDashboard(input)).artifacts[0].states.find((state) => state.name === name)
  meta['art.tested_checked_at'] = '2026-10-28T12:00Z'
  assert.equal(stateOf('tested').stale, false)
  meta['art.tested_checked_at'] = '2026-10-28T11:59Z'
  assert.equal(stateOf('tested').stale, true)
  meta['art.tested_checked_at'] = '2026-10-30T12:00Z'
  assert.equal(stateOf('tested').stale, false)
  input.artifacts[0].metadata = { 'art.live_source': 'hvir reload' }
  assert.deepEqual(stateOf('live'), { name: 'live', claimed: true, at: '', source: 'hvir reload', checkedAt: '', stale: false })
})

test('an artifact joined through a parent-child dependency attaches in either dependency shape', () => {
  for (const edge of [{ type: 'parent-child', depends_on_id: 'fx-project-1' },
    { dependency_type: 'parent-child', id: 'fx-project-1' }]) {
    const input = fresh()
    delete input.artifacts[0].parent
    input.artifacts[0].dependencies = [edge]
    assert.equal(card(buildDashboard(input)).artifacts.some((entry) => entry.id === 'fx-art-1'), true)
  }
})

test('answerTo prefers gc.owner, then created_by, and is absent without either', () => {
  const input = fresh()
  input.decisions = [
    { id: 'a1', title: 'Both', status: 'open', labels: ['needs/stephanie'], metadata: { 'gc.owner': 'mayor' }, created_by: 'omni-pl' },
    { id: 'a2', title: 'Creator only', status: 'open', labels: ['needs/stephanie'], metadata: { 'gc.owner': ' ' }, created_by: 'omni-pl' },
    { id: 'a3', title: 'Neither', status: 'open', labels: ['needs/stephanie'], metadata: {} },
  ]
  const asks = Object.fromEntries(buildDashboard(input).needsYou.map((ask) => [ask.id, ask]))
  assert.equal(asks.a1.answerTo, 'mayor')
  assert.equal(asks.a1.answerLive, false)
  assert.equal(asks.a2.answerTo, 'omni-pl')
  assert.equal(asks.a2.answerLive, true)
  assert.equal('answerTo' in asks.a3, false)
  assert.equal(asks.a1.title, 'Both')
})

test('a session holding several in-progress beads counts toward every project it works', () => {
  const input = fresh()
  input.inProgress.push({ id: 'fx-lead-other', title: 'Second project work', status: 'in_progress',
    labels: [], metadata: { 'proj.id': 'fx-project-2' }, assignee: 'omni-pl' })
  const model = buildDashboard(input)
  assert.deepEqual(card(model, 'fx-project-1').inFlight.filter((row) => row.who === 'omni-pl').map((row) => row.bead.id), ['fx-lead-work'])
  assert.deepEqual(card(model, 'fx-project-2').inFlight.filter((row) => row.who === 'omni-pl').map((row) => row.bead.id), ['fx-lead-other'])
  assert.equal(card(model, 'fx-project-2').agentsActive, 2)
})

test('two beads of one project held by one session count as one active agent', () => {
  const input = fresh()
  input.inProgress.push({ id: 'fx-lead-second', title: 'More catalog work', status: 'in_progress',
    labels: [], metadata: { 'proj.id': 'fx-project-1' }, assignee: 'omni-pl' })
  const project = card(buildDashboard(input))
  assert.equal(project.inFlight.filter((row) => row.who === 'omni-pl').length, 2)
  assert.equal(project.agentsActive, new Set(project.active.map((item) => item.session)).size)
})

test('in flight lists live workers with bead, start and model, and live seat jobs', () => {
  const model = buildDashboard(fresh())
  const row = card(model).inFlight.find((entry) => entry.bead.id === 'fx-lead-work')
  assert.equal(row.working, true)
  assert.equal(row.who, 'omni-pl')
  assert.equal(row.bead.title, 'Shape the catalog launch')
  assert.equal(row.model, 'gpt-fixture')
  assert.equal(row.startedAt, '2026-10-29T09:00Z')
  const seat = card(model, 'fx-project-3').inFlight.find((entry) => entry.bead.id === 'fx-seat-work')
  assert.equal(seat.working, true)
  assert.match(seat.who, /city-infra-pl/)
})

test('a claimed in-progress bead with no live session or seat job is flagged, not counted active', () => {
  const input = fresh()
  input.inProgress.push({ id: 'fx-claimed', title: 'Claimed and abandoned', status: 'in_progress',
    labels: [], metadata: { 'proj.id': 'fx-project-1' }, assignee: 'fx-gone' })
  const project = card(buildDashboard(input))
  const row = project.inFlight.find((entry) => entry.bead.id === 'fx-claimed')
  assert.equal(row.working, false)
  assert.equal(row.who, 'fx-gone')
  assert.ok(!project.active.some((item) => item.bead?.id === 'fx-claimed'))
})

test('a claimed bead whose assignee has a live seat job elsewhere is not flagged', () => {
  const input = fresh()
  input.inProgress.push({ id: 'fx-seat-claim', title: 'Seat owned', status: 'in_progress',
    labels: [], metadata: { 'proj.id': 'fx-project-1' }, assignee: 'city-infra-pl' })
  const row = card(buildDashboard(input)).inFlight.find((entry) => entry.bead.id === 'fx-seat-claim')
  assert.equal(row, undefined)
})

test('queued lists open beads of the project with owner and what they wait on, and skips records', () => {
  const input = fresh()
  input.linked = [
    { id: 'fx-q1', title: 'Rebuild stack', status: 'open', labels: [], assignee: 'omni-pl', store: 's',
      metadata: { 'proj.id': 'fx-project-1', 'gc.waiting_on': 'fx-q2' } },
    { id: 'fx-q2', title: 'Unowned step', status: 'open', labels: [], store: 's', metadata: { 'gc.project': 'fx-project-1' } },
    { id: 'fx-q3', title: 'Running', status: 'in_progress', labels: [], store: 's', metadata: { 'proj.id': 'fx-project-1' } },
    { id: 'fx-q4', title: 'A milestone', status: 'open', labels: ['city-milestone'], store: 's', metadata: { 'proj.id': 'fx-project-1' } },
    { id: 'fx-q5', title: 'Other project', status: 'open', labels: [], store: 's', metadata: { 'proj.id': 'fx-project-2' } },
    { id: 'fx-q6', title: 'Workflow root', status: 'open', labels: [], store: 's',
      metadata: { 'proj.id': 'fx-project-1', 'gc.kind': 'workflow' } },
  ]
  const model = buildDashboard(input)
  const queued = card(model).queued
  assert.deepEqual(queued.map((entry) => entry.id), ['fx-q1', 'fx-q2'])
  assert.equal(queued[0].owner, 'omni-pl')
  assert.equal(queued[0].waitingOn, 'fx-q2')
  assert.equal(queued[1].owner, '')
  assert.deepEqual(card(model, 'fx-project-2').queued.map((entry) => entry.id), ['fx-q5'])
})

test('queued skips open decisions raised against the project', () => {
  const input = fresh()
  const ask = input.decisions.find((bead) => bead.status === 'open' && bead.metadata?.['gc.project'])
  input.linked = [{ ...ask }]
  const model = buildDashboard(input)
  assert.ok(!cards(model).some((entry) => entry.queued.some((row) => row.id === ask.id)))
})

const urgent = (id, extra = {}) => ({ id, title: `Title ${id}`, status: 'open', priority: 1, labels: [],
  store: 's', updated_at: '2026-10-29T08:00:00Z', metadata: {}, ...extra })

test('stuck lists urgent open work with no waiting note, oldest update first, and waiting lists the rest', () => {
  const input = fresh()
  input.urgent = [
    urgent('fx-u-new', { updated_at: '2026-10-29T10:00:00Z', assignee: 'omni-pl' }),
    urgent('fx-u-old', { updated_at: '2026-10-28T10:00:00Z' }),
    urgent('fx-u-wait', { metadata: { 'gc.waiting_on': 'omni-49z8xs' }, updated_at: '2026-10-29T06:00:00Z' }),
    urgent('fx-u-p2', { priority: 2 }),
    urgent('fx-u-closed', { status: 'closed' }),
    urgent('fx-u-record', { labels: ['city-milestone'] }),
    urgent('fx-u-root', { metadata: { 'gc.kind': 'workflow' } }),
    urgent('fx-u-prog', { status: 'in_progress', priority: 0, updated_at: '2026-10-29T09:00:00Z' }),
  ]
  input.urgent.push({ ...input.urgent[0] })
  const model = buildDashboard(input)
  assert.deepEqual(model.stuck.items.map((row) => row.id), ['fx-u-old', 'fx-u-prog', 'fx-u-new'])
  assert.equal(model.stuck.items[0].owner, '')
  assert.equal(model.stuck.items[2].owner, 'omni-pl')
  assert.equal(model.stuck.items[0].updatedAt, '2026-10-28T10:00:00Z')
  assert.deepEqual(model.waiting.items.map((row) => [row.id, row.waitingOn]), [['fx-u-wait', 'omni-49z8xs']])
})

test('waiting lists what waits on her first, longest waiting first, then the other waits in their usual order', () => {
  const input = fresh()
  input.urgent = [
    urgent('fx-w-agent-old', { metadata: { 'gc.waiting_on': 'omni-pl' }, updated_at: '2026-10-27T10:00:00Z' }),
    urgent('fx-w-her-new', { metadata: { 'gc.waiting_on': 'stephanie' }, updated_at: '2026-10-29T10:00:00Z' }),
    urgent('fx-w-time', { metadata: { 'gc.waiting_on': 'time' }, updated_at: '2026-10-28T10:00:00Z' }),
    urgent('fx-w-her-caps', { metadata: { 'gc.waiting_on': ' Stephanie ' }, updated_at: '2026-10-28T12:00:00Z' }),
    urgent('fx-w-step', { labels: ['Needs/Stephanie-Step'], updated_at: '2026-10-29T08:00:00Z' }),
    urgent('fx-w-her-note', { metadata: { 'gc.waiting_on': 'stephanie: reload the extension' }, updated_at: '2026-10-26T10:00:00Z' }),
    urgent('fx-w-named', { metadata: { 'gc.waiting_on': 'stephanie-bot' }, updated_at: '2026-10-25T10:00:00Z' }),
    urgent('fx-w-agent-tie', { metadata: { 'gc.waiting_on': 'om-1' }, updated_at: '2026-10-28T10:00:00Z' }),
    urgent('fx-w-undated', { metadata: { 'gc.waiting_on': 'stephanie' }, updated_at: 'never' }),
  ]
  const model = buildDashboard(input)
  assert.deepEqual(model.waiting.items.map((row) => row.id), [
    'fx-w-her-note', 'fx-w-her-caps', 'fx-w-step', 'fx-w-her-new', 'fx-w-undated',
    'fx-w-named', 'fx-w-agent-old', 'fx-w-agent-tie', 'fx-w-time',
  ])
  assert.equal(model.waiting.items.find((row) => row.id === 'fx-w-step').waitingOn, 'stephanie')
  assert.ok(!model.stuck.items.some((row) => row.id === 'fx-w-step'))
})

test('stuck skips decisions, merges inProgress and linked reads, and caps at fifty with a remainder', () => {
  const input = fresh()
  const ask = input.decisions[0]
  input.urgent = [urgent(ask.id, { store: ask.store })]
  input.linked = [urgent('fx-l1')]
  input.inProgress.push(urgent('fx-ip1', { status: 'in_progress' }))
  const ids = buildDashboard(input).stuck.items.map((row) => row.id)
  assert.ok(ids.includes('fx-l1') && ids.includes('fx-ip1') && !ids.includes(ask.id))
  const many = fresh()
  many.urgent = Array.from({ length: 53 }, (_, i) => urgent(`fx-m${i}`, { updated_at: `2026-10-0${1 + (i % 9)}T00:00:00Z` }))
  const capped = buildDashboard(many).stuck
  assert.equal(capped.items.length, 50)
  assert.equal(capped.more, 3)
})

test('stuck and waiting skip automatic workflow step beads', () => {
  const input = fresh()
  input.urgent = [
    urgent('fx-s-root', { metadata: { 'gc.root_bead_id': 'fx-root-catalog' } }),
    urgent('fx-s-ref', { metadata: { 'gc.step_ref': 'mol.spec' } }),
    urgent('fx-s-wait', { metadata: { 'gc.root_bead_id': 'r', 'gc.waiting_on': 'x' } }),
    urgent('fx-s-real'),
  ]
  const model = buildDashboard(input)
  assert.deepEqual(model.stuck.items.map((row) => row.id), ['fx-s-real'])
  assert.deepEqual(model.waiting.items, [])
})

const convoy = (id, tracked, extra = {}) => urgent(id, { title: `input convoy for ${tracked}`, issue_type: 'convoy',
  metadata: { 'gc.synthetic': 'true' }, dependencies: [{ issue_id: id, depends_on_id: tracked, type: 'tracks' }], ...extra })

test('a synthetic convoy row shows the bead it tracks, once, with that bead\'s state', () => {
  const input = fresh()
  input.urgent = [
    convoy('fx-c1', 'fx-t1'),
    urgent('fx-t1', { title: 'Tracked work', status: 'in_progress', assignee: 'omni-pl' }),
    convoy('fx-c2', 'fx-t2', { store: 's2' }),
    convoy('fx-c3', 'fx-t3'),
    urgent('fx-plain-convoy', { issue_type: 'convoy', dependencies: [{ depends_on_id: 'fx-x', type: 'tracks' }] }),
  ]
  input.linked = [urgent('fx-t3', { title: 'Tracked elsewhere', priority: 2, status: 'open' })]
  const rows = buildDashboard(input).stuck.items
  assert.deepEqual(rows.map((row) => row.id).sort(), ['fx-plain-convoy', 'fx-t1', 'fx-t2', 'fx-t3'])
  const byId = (id) => rows.find((row) => row.id === id)
  assert.deepEqual([byId('fx-t1').title, byId('fx-t1').state, byId('fx-t1').owner], ['Tracked work', 'in_progress', 'omni-pl'])
  assert.deepEqual([byId('fx-t2').title, byId('fx-t2').state, byId('fx-t2').store, byId('fx-t2').convoy], ['', '', 's2', 'fx-c2'])
  assert.deepEqual([byId('fx-t3').title, byId('fx-t3').state, byId('fx-t3').convoy], ['Tracked elsewhere', 'open', 'fx-c3'])
})

test('a stuck row names its owner seat, falling back to the project lead, and an unclaimed pool route', () => {
  const input = fresh()
  input.urgent = [
    urgent('fx-o-assigned', { assignee: 'omni-evals-pl', metadata: { 'proj.id': 'fx-project-1' } }),
    urgent('fx-o-lead', { metadata: { 'proj.id': 'fx-project-1' } }),
    urgent('fx-o-gc-project', { metadata: { 'gc.project': 'fx-project-1' } }),
    urgent('fx-o-routed', { metadata: { 'gc.execution_routed_to': 'omni-experiments/omni-experiments-worker' } }),
    urgent('fx-o-routed-claimed', { assignee: 'pool-2', metadata: { 'gc.execution_routed_to': 'omni-experiments/omni-experiments-worker' } }),
    urgent('fx-o-none'),
  ]
  const rows = buildDashboard(input).stuck.items
  const byId = (id) => rows.find((row) => row.id === id)
  assert.deepEqual([byId('fx-o-assigned').owner, byId('fx-o-assigned').ownerFrom], ['omni-evals-pl', 'assignee'])
  assert.deepEqual([byId('fx-o-lead').owner, byId('fx-o-lead').ownerFrom], ['omni-pl', 'project lead'])
  assert.deepEqual([byId('fx-o-gc-project').owner, byId('fx-o-gc-project').ownerFrom], ['omni-pl', 'project lead'])
  assert.deepEqual([byId('fx-o-none').owner, byId('fx-o-none').ownerFrom], ['', ''])
  assert.equal(byId('fx-o-routed').unclaimedBy, 'omni-experiments/omni-experiments-worker')
  assert.equal(byId('fx-o-routed-claimed').unclaimedBy, '')
  assert.equal(byId('fx-o-none').unclaimedBy, '')
})

const cardRecord = (texts) => ({ id: 'om-p86nj8', title: 'Card texts', status: 'open', labels: ['city-artifact', 'city-infra'],
  store: '/hq', metadata: { 'gc.card_texts': typeof texts === 'string' ? texts : JSON.stringify(texts) } })

test('card text comes from the bead itself first, then the card text record, else nothing', () => {
  const input = fresh()
  const ask = input.decisions.find((bead) => bead.status === 'open' && (bead.labels ?? []).includes('needs/stephanie') && !bead.metadata?.['gc.answered'])
  const step = { id: 'dec-step', title: 'Step', status: 'open', labels: ['needs/stephanie-step'], store: '/rigs/decisions', metadata: {} }
  input.herSteps = [step]
  input.urgent = [
    urgent('fx-own', { metadata: { 'gc.card_text': 'Own words.' } }),
    urgent('fx-mapped'),
    urgent('fx-none'),
  ]
  input.artifacts = [...input.artifacts, cardRecord({ 'fx-own': 'Map words lose.', 'fx-mapped': ' Map words. ', [ask.id]: 'Ask words.',
    'dec-step': 'Step words.', 'fx-none': 7 })]
  const model = buildDashboard(input)
  const row = (id) => model.stuck.items.find((entry) => entry.id === id)
  assert.equal(row('fx-own').cardText, 'Own words.')
  assert.equal(row('fx-mapped').cardText, 'Map words.')
  assert.equal(row('fx-none').cardText, '')
  assert.equal(model.needsYou.find((entry) => entry.id === ask.id).cardText, 'Ask words.')
  assert.equal(model.herSteps.find((entry) => entry.id === 'dec-step').cardText, 'Step words.')
  assert.equal(model.cardTextsInvalid, false)
  assert.ok(!cards(model).some((entry) => entry.artifacts.some((artifact) => artifact.id === 'om-p86nj8')))
})

test('an unreadable card text record leaves rows on their own text and says so', () => {
  for (const broken of ['{not json', '[1,2]', 'null']) {
    const input = fresh()
    input.urgent = [urgent('fx-mapped')]
    input.artifacts = [...input.artifacts, cardRecord(broken)]
    const model = buildDashboard(input)
    assert.equal(model.stuck.items[0].cardText, '')
    assert.equal(model.cardTextsInvalid, true)
  }
  const absent = buildDashboard(fresh())
  assert.equal(absent.cardTextsInvalid, false)
})

test('a wait on her, a decision or an agent for over a day is likely broken; a wait on a resource or time is not', () => {
  const input = fresh()
  const old = '2026-10-28T10:00:00Z'
  const waits = (id, waitingOn, extra = {}) => urgent(id, { updated_at: old, metadata: { 'gc.waiting_on': waitingOn }, ...extra })
  input.urgent = [
    waits('fx-b-her', 'stephanie'),
    waits('fx-b-her-note', 'Stephanie: reload the extension'),
    waits('fx-b-her-new', 'stephanie', { updated_at: '2026-10-29T10:00:00Z' }),
    waits('fx-b-her-undated', 'stephanie', { updated_at: 'never' }),
    urgent('fx-b-step', { updated_at: old, labels: ['needs/stephanie-step'] }),
    waits('fx-b-dec', 'dec-qs0x (her: relaunch the run)'),
    waits('fx-b-bead-agent', 'fx-b-target-owned landing (lead'),
    waits('fx-b-bead-free', 'fx-b-target-free'),
    waits('fx-b-seat', '(omni-pl, reassigned by omni-evals-pl)'),
    waits('fx-b-time', 'time'),
    waits('fx-b-disk', 'disk need: free 195136604 KB'),
    waits('fx-b-date', '2026-11-16 week-after proof'),
    urgent('fx-b-unclaimed', { updated_at: old, metadata: { 'gc.execution_routed_to': 'rig/rig-worker' } }),
    urgent('fx-b-quiet', { updated_at: old }),
  ]
  input.linked = [
    urgent('fx-b-target-owned', { priority: 2, assignee: 'omni-experiments-worker' }),
    urgent('fx-b-target-free', { priority: 2 }),
  ]
  const model = buildDashboard(input)
  const rows = [...model.stuck.items, ...model.waiting.items]
  const broken = rows.filter((row) => row.likelyBroken).map((row) => row.id).sort()
  assert.deepEqual(broken, ['fx-b-bead-agent', 'fx-b-dec', 'fx-b-her', 'fx-b-her-note', 'fx-b-seat', 'fx-b-step', 'fx-b-unclaimed'])
  const kind = (id) => rows.find((row) => row.id === id).waitKind
  assert.deepEqual(['fx-b-her', 'fx-b-dec', 'fx-b-bead-agent', 'fx-b-seat', 'fx-b-unclaimed', 'fx-b-time', 'fx-b-quiet'].map(kind),
    ['her', 'decision', 'agent', 'agent', 'agent', '', ''])
})

test('a claimed bead says "no live session" until seat jobs were actually read', () => {
  const claim = { id: 'fx-claimed', title: 'Claimed', status: 'in_progress', labels: [],
    metadata: { 'proj.id': 'fx-project-1' }, assignee: 'fx-gone' }
  const rowOf = (input) => card(buildDashboard(input)).inFlight.find((entry) => entry.bead.id === 'fx-claimed')
  const unread = fresh()
  unread.seatJobs = []
  unread.inProgress.push(claim)
  assert.equal(rowOf(unread).claim, 'no live session')
  const absent = fresh()
  delete absent.seatJobs
  absent.inProgress.push(claim)
  assert.equal(rowOf(absent).claim, 'no live session')
  const readEmpty = { ...unread, seatJobsRead: true }
  assert.equal(rowOf(readEmpty).claim, 'nobody working')
  const populated = fresh()
  populated.inProgress.push(claim)
  assert.equal(rowOf(populated).claim, 'nobody working')
})

test('a session matches its work by alias as well as id, name and agent name', () => {
  const input = fresh()
  input.sessions.push({ id: 'fx-s-alias', name: 'fx-long-name', alias: 'fx-alias', agent_name: 'fx-pool',
    command: 'codex', provider: 'codex', started_at: '2026-10-29T12:00Z' })
  input.inProgress.push({ id: 'fx-by-alias', title: 'By alias', status: 'in_progress', labels: [],
    metadata: { 'proj.id': 'fx-project-1' }, assignee: 'fx-alias' })
  const rows = card(buildDashboard(input)).inFlight.filter((entry) => entry.bead.id === 'fx-by-alias')
  assert.deepEqual(rows.map((entry) => [entry.who, entry.working]), [['fx-long-name', true]])
})

test('coverage is keyed by store and id so a shared bead id in another store is still flagged', () => {
  const input = fresh()
  input.inProgress = input.inProgress.map((bead) => ({ ...bead, store: '/a' }))
  input.inProgress.push({ id: 'fx-lead-work', title: 'Twin in another store', status: 'in_progress', labels: [],
    metadata: { 'proj.id': 'fx-project-1' }, assignee: 'fx-gone', store: '/b' })
  const rows = card(buildDashboard(input)).inFlight.filter((entry) => entry.bead.id === 'fx-lead-work')
  assert.deepEqual(rows.map((entry) => [entry.bead.store, entry.working]).sort(), [['/a', true], ['/b', false]])
  const queued = fresh()
  queued.inProgress = queued.inProgress.map((bead) => ({ ...bead, store: '/a' }))
  queued.linked = [{ id: 'fx-lead-work', title: 'Twin queued', status: 'open', labels: [], store: '/b',
    metadata: { 'proj.id': 'fx-project-1' } }]
  assert.deepEqual(card(buildDashboard(queued)).queued.map((entry) => entry.store), ['/b'])
})

test('an open bead with a start receipt is not queued', () => {
  const input = fresh()
  input.linked = [
    urgent('fx-r-started', { metadata: { 'proj.id': 'fx-project-1', 'receipt.started_at': '2026-10-29T08:00Z' } }),
    urgent('fx-r-plain', { metadata: { 'proj.id': 'fx-project-1' } }),
  ]
  assert.deepEqual(card(buildDashboard(input)).queued.map((entry) => entry.id), ['fx-r-plain'])
})

test('decisions are kept out of Stuck and Waiting on by shape, whatever store they came from', () => {
  const input = fresh()
  input.urgent = [
    urgent('dec-abc1', { status: 'in_progress', store: '/elsewhere' }),
    urgent('fx-labelled', { labels: ['needs/stephanie'], store: '/elsewhere' }),
    urgent('dec-wait1', { metadata: { 'gc.waiting_on': 'x' } }),
    urgent('fx-real'),
  ]
  const model = buildDashboard(input)
  assert.deepEqual(model.stuck.items.map((row) => row.id), ['fx-real'])
  assert.deepEqual(model.waiting.items, [])
})

test('in flight and queued cap at twenty rows with the remainder counted', () => {
  const input = fresh()
  input.linked = Array.from({ length: 23 }, (_, i) => urgent(`fx-cq${i}`, { metadata: { 'proj.id': 'fx-project-1' } }))
  input.inProgress.push(...Array.from({ length: 22 }, (_, i) => ({ id: `fx-cf${i}`, title: `Claim ${i}`,
    status: 'in_progress', labels: [], metadata: { 'proj.id': 'fx-project-1' }, assignee: `fx-ghost-${i}` })))
  const project = card(buildDashboard(input))
  assert.equal(project.queued.length, 20)
  assert.equal(project.queuedMore, 3)
  assert.equal(project.inFlight.length, 20)
  assert.equal(project.inFlightMore, project.inFlightTotal - 20)
  assert.ok(project.inFlightTotal >= 22)
})
