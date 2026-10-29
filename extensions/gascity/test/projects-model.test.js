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
    next: { id: 'fx-ms-1', title: 'Searchable catalog', target: '2026-11-02', state: 'active' } })
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
