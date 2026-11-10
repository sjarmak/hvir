const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')
const { buildDashboard } = require('../projects-model.js')
const fixture = require('./fixtures/projects-dashboard.json')

const preview = () => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) {
    window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  }
  const root = window.document.querySelector('main')
  const beads = []
  const refs = []
  const model = buildDashboard(structuredClone(fixture))
  window.projectsRender.renderDashboard(model, root, {
    onOpenBead: (id) => beads.push(id),
    onOpenRef: (ref) => refs.push(ref),
  })
  return { dom, window, root, beads, refs, model }
}

test('renderer shows fixture cards, needs, unlinked activity and readable work titles', (t) => {
  const { dom, root } = preview()
  t.after(() => dom.window.close())
  assert.equal(root.querySelectorAll('.projects-card').length, 5)
  const asks = root.firstElementChild.textContent
  assert.match(asks, /Shared signal board/)
  assert.match(asks, /No project/)
  assert.doesNotMatch(asks, /Pick a catalog accent/)
  const face = root.querySelector('.projects-card-face')
  assert.match(face.textContent, /Build catalog search/)
  assert.match(face.textContent, /mol-scoped-work · implement · 1\/2 steps done/)
  assert.match(face.textContent, /gpt-fixture-small · Running 1h/)
  assert.doesNotMatch(face.textContent, /fx-(?:project|step|root|lead-work)/)
  assert.equal(face.querySelector('.projects-chip').dataset.state, 'moving')
  assert.equal(face.querySelector('progress').value, 1)
  assert.equal(face.querySelector('progress').max, 2)
  assert.doesNotMatch(root.textContent, /not updated in 24h|Updated 2026/)
  assert.match(face.querySelector('.projects-times').textContent, /^Fetched \S+ ago · /)
  assert.match(face.querySelector('.projects-unverified').textContent, /^Waits: unverified/)
  assert.match(root.textContent, /fx-review-account/)
})

test('card click and keyboard-accessible toggle expose timeline, decisions and workflows', (t) => {
  const { dom, root } = preview()
  t.after(() => dom.window.close())
  const face = root.querySelector('.projects-card-face')
  const detail = root.querySelector('.projects-detail')
  const toggle = face.querySelector('[aria-expanded]')
  assert.equal(detail.hidden, true)
  face.querySelector('h3').click()
  assert.equal(detail.hidden, false)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.match(detail.textContent, /A synthetic baseline was delivered/)
  assert.match(detail.textContent, /implement · fx-worker-a/)
  toggle.click()
  assert.equal(detail.hidden, true)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
})

test('decision and reference actions emit targets without toggling the card', (t) => {
  const { dom, root, beads, refs } = preview()
  t.after(() => dom.window.close())
  root.querySelector('section li button').click()
  assert.deepEqual(beads, ['fx-ask-retention'])
  const face = root.querySelector('.projects-card-face')
  face.querySelector('.projects-refs button').click()
  assert.equal(refs[0].key, 'fixture-lab/lantern#12')
  assert.equal(refs[0].kind, 'pr')
  assert.equal(root.querySelector('.projects-detail').hidden, true)
  face.querySelectorAll('.projects-refs button')[1].click()
  assert.equal(refs[1].kind, 'issue')
})

test('rerender replaces content and empty dashboards have explicit empty states', (t) => {
  const { dom, window, root, model } = preview()
  t.after(() => dom.window.close())
  window.projectsRender.renderDashboard(model, root)
  assert.equal(root.querySelectorAll('.projects-card').length, 5)
  window.projectsRender.renderDashboard(buildDashboard({ now: fixture.now }), root)
  assert.equal(root.querySelectorAll('.projects-card').length, 0)
  assert.match(root.textContent, /Nothing needs you/)
  assert.match(root.textContent, /No active agents/)
})

test('standalone file preview loads its local scripts with fixed time and theme controls', async (t) => {
  const dom = await JSDOM.fromFile(`${__dirname}/projects-preview.html`, {
    runScripts: 'dangerously', resources: 'usable',
  })
  t.after(() => dom.window.close())
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview load timed out')), 3000)
    dom.window.addEventListener('load', () => { clearTimeout(timer); resolve() }, { once: true })
  })
  const { document } = dom.window
  assert.equal(document.querySelectorAll('.projects-card').length, 5)
  assert.equal(dom.window.Date.now(), Date.parse(fixture.now))
  document.getElementById('theme').click()
  assert.equal(document.documentElement.dataset.theme, 'light')
  document.querySelector('#projects section li button').click()
  assert.equal(document.getElementById('preview-action').textContent, 'Bead target: fx-ask-retention')
})

test('project detail lists in-progress beads collapsed by default, each opening its bead', (t) => {
  const { dom, root, beads, model } = preview()
  t.after(() => dom.window.close())
  const index = model.cards.flatMap((group) => group.cards).findIndex((entry) => entry.inProgress.length > 0)
  const detail = root.querySelectorAll('.projects-detail')[index]
  const drill = detail.querySelector('details')
  assert.equal(drill.open, false)
  assert.match(drill.querySelector('summary').textContent, /^In progress \([1-9]\d*\)$/)
  drill.querySelector('li button').click()
  assert.equal(beads.length, 1)
})

test('an invalid reference shows her a plain link-missing note, never the raw value', (t) => {
  const { dom, root } = preview()
  t.after(() => dom.window.close())
  const warnings = [...root.querySelectorAll('.projects-refs .projects-warning')].map((node) => node.textContent)
  assert.ok(warnings.includes('link missing'))
  assert.equal(root.textContent.includes('bad reference'), false)
})

test('recent outcomes appear only when the outcome reader supplied them, at most three per card', (t) => {
  const { dom, root } = preview()
  t.after(() => dom.window.close())
  assert.equal(root.textContent.includes('Recent outcomes'), false)
  const input = structuredClone(fixture)
  input.outcomes = Array.from({ length: 5 }, (_, index) => ({
    time: `2026-10-2${index}T03:00Z`, title: `Outcome ${index}`, outcome: '', projects: ['fx-project-1'] }))
  dom.window.projectsRender.renderDashboard(buildDashboard(input), root, {})
  const face = [...root.querySelectorAll('.projects-card-face')].find((node) => node.textContent.includes('Outcome 0'))
  const recent = [...face.querySelectorAll('section')].find((node) => node.querySelector('h2')?.textContent === 'Recent outcomes')
  assert.equal(recent.querySelectorAll('li').length, 3)
  assert.equal(face.parentElement.querySelector('.projects-detail').textContent.includes('Outcome 4'), true)
})

const navPreview = () => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = window.document.querySelector('main')
  const opened = []
  const model = buildDashboard(structuredClone(fixture))
  window.projectsRender.renderNav(model, root, {
    onOpenBead: (id) => opened.push(['bead', id]),
    onOpenProject: (id, store) => opened.push(['project', id, store]),
    onOpenOverview: () => opened.push(['overview']),
  })
  return { dom, root, opened, model }
}

test('the rail is a compact navigation list: counts, asks, one row per project, no cards', (t) => {
  const { dom, root, opened, model } = navPreview()
  t.after(() => dom.window.close())
  assert.equal(root.querySelectorAll('.projects-card').length, 0)
  assert.equal(root.querySelectorAll('.projects-nav-row').length, 6)
  assert.match(root.textContent, /2 need you · 1 answered, waiting on agents/)
  root.querySelector('.projects-nav-overview').click()
  const row = [...root.querySelectorAll('.projects-nav-row')].find((node) => /Shared signal board/.test(node.textContent))
  row.click()
  const shared = model.cards.flatMap((group) => group.cards).find((entry) => entry.title === 'Shared signal board')
  assert.deepEqual(opened, [['overview'], ['project', shared.id, shared.store]])
  assert.match(row.textContent, /1 needs you/)
})

test('a project page shows the whole project with decisions split by who acts next', (t) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = window.document.querySelector('main')
  const model = buildDashboard(structuredClone(fixture))
  const project = model.cards.flatMap((group) => group.cards).find((entry) => entry.id === 'fx-project-1')
  window.projectsRender.renderProject(project, root, {})
  assert.equal(root.querySelector('h1').textContent, project.title)
  assert.ok(root.querySelector('.projects-page-grid'))
  assert.match(root.textContent, /Answered, waiting on agents/)
  assert.match(root.textContent, /Needs you.*Nothing needs you/s)
  assert.equal(root.querySelectorAll('[aria-expanded]').length, 0)
})

test('an unanswered decision without her label is listed as other open, never as answered', (t) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const input = structuredClone(fixture)
  input.decisions.push({ id: 'fx-plain', title: 'Plain open record', status: 'open', metadata: { 'gc.project': 'fx-project-1' } })
  const project = buildDashboard(input).cards.flatMap((group) => group.cards).find((entry) => entry.id === 'fx-project-1')
  const root = window.document.querySelector('main')
  window.projectsRender.renderProject(project, root, {})
  const sections = Object.fromEntries([...root.querySelectorAll('.projects-page-grid section')]
    .map((node) => [node.querySelector('h2').textContent, node.textContent]))
  assert.doesNotMatch(sections['Answered, waiting on agents'], /Plain open record/)
  assert.match(sections['Other open decisions'], /Plain open record/)
})

const pageFor = (t, id, options = {}) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const project = buildDashboard(structuredClone(fixture)).cards.flatMap((group) => group.cards).find((entry) => entry.id === id)
  const root = window.document.querySelector('main')
  window.projectsRender.renderProject(project, root, options)
  return { root, project }
}

test('a project page never prints false or undefined for absent optional fields', (t) => {
  const { root } = pageFor(t, 'fx-project-1')
  assert.doesNotMatch(root.textContent, /false|undefined/)
})

test('a project page leads with an at-a-glance strip and offers a way back to the overview', (t) => {
  const back = []
  const { root, project } = pageFor(t, 'fx-project-1', { onOpenOverview: () => back.push('overview') })
  const tiles = [...root.querySelectorAll('.projects-glance .projects-tile')].map((node) => node.textContent)
  assert.ok(tiles.some((text) => /Milestones/.test(text) && text.includes(`${project.milestones.done}/${project.milestones.total}`)))
  assert.ok(tiles.some((text) => /Needs you/.test(text)))
  root.querySelector('.projects-back').click()
  assert.deepEqual(back, ['overview'])
})

test('a reference without a known state shows its key only, not "state unknown"', (t) => {
  const { root } = pageFor(t, 'fx-project-1')
  assert.doesNotMatch(root.textContent, /state unknown/)
})

test('a project page shows the stored blocker, next step and artifacts as tested, installed and live', (t) => {
  const { root } = pageFor(t, 'fx-project-1')
  const sections = Object.fromEntries([...root.querySelectorAll('.projects-page-grid section')]
    .map((node) => [node.querySelector('h2').textContent, node]))
  assert.match(sections.Now.textContent, /Blocker: Waiting on the catalog index rebuild\./)
  assert.match(sections.Now.textContent, /Next step: omni-pl reruns the import once the index is back\./)
  const artifacts = sections.Artifacts
  assert.ok(artifacts)
  const rows = [...artifacts.querySelectorAll('.projects-artifact')]
  assert.equal(rows.length, 2)
  assert.match(rows[0].textContent, /fixture-lab\/lantern@abc1234/)
  const states = [...rows[0].querySelectorAll('.projects-artifact-state')].map((node) => node.textContent)
  assert.equal(states.length, 3)
  assert.match(states[0], /^Tested.*2026-10-29T09:00Z.*checked 2026-10-29T11:00Z.*node --test test\/\*\.test\.js/)
  assert.match(states[1], /^Installed.*not checked in 24h/)
  assert.match(states[2], /^Live.*not claimed/)
  assert.equal(rows[0].querySelectorAll('.projects-warning').length, 1)
  assert.match(rows[1].textContent, /closed/)
  assert.doesNotMatch(root.textContent, /false|undefined/)
})

test('a project without stored blocker, next step or artifacts shows no empty labels', (t) => {
  const { root } = pageFor(t, 'fx-project-2')
  assert.doesNotMatch(root.textContent, /Blocker:|Next step:/)
  assert.match(root.textContent, /Artifacts.*No artifacts recorded/s)
})

test('an artifact with only some fields shows unknowns as words, never null, false or undefined', (t) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const input = structuredClone(fixture)
  input.artifacts[0].metadata = { 'art.ref': 'fixture-lab/lantern@abc1234', 'art.tested_at': '2026-10-29T09:00Z' }
  const project = buildDashboard(input).cards.flatMap((group) => group.cards).find((entry) => entry.id === 'fx-project-1')
  const root = window.document.querySelector('main')
  window.projectsRender.renderProject(project, root, {})
  const row = root.querySelector('.projects-artifact')
  assert.match(row.textContent, /unknown kind/)
  assert.match(row.textContent, /Tested · since 2026-10-29T09:00Z · checked unknown · no source recorded/)
  assert.equal(row.querySelectorAll('.projects-warning').length, 0)
  assert.doesNotMatch(root.textContent, /null|false|undefined/)
})

test('a claimed state with no first-claim time says since unknown', (t) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const input = structuredClone(fixture)
  input.artifacts[0].metadata = { 'art.kind': 'path', 'art.ref': '/fixture/x', 'art.live_source': 'hvir reload' }
  const project = buildDashboard(input).cards.flatMap((group) => group.cards).find((entry) => entry.id === 'fx-project-1')
  const root = window.document.querySelector('main')
  window.projectsRender.renderProject(project, root, {})
  const live = [...root.querySelector('.projects-artifact').querySelectorAll('.projects-artifact-state')][2]
  assert.match(live.textContent, /^Live · since unknown · checked unknown · hvir reload$/)
  assert.doesNotMatch(root.textContent, /null|false|undefined/)
})

test('the unverified waits marker shows on face, page, glance and nav until the record declares its waits', (t) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = window.document.querySelector('main')
  const build = (meta, extra = {}) => {
    const input = structuredClone(fixture)
    const target = input.projects.find((entry) => entry.id === 'fx-project-1')
    target.metadata = { ...target.metadata, ...meta }
    return buildDashboard({ ...input, ...extra }).cards.flatMap((group) => group.cards).find((entry) => entry.id === 'fx-project-1')
  }
  const undeclared = build({})
  window.projectsRender.renderProject(undeclared, root, {})
  assert.match(root.querySelector('.projects-unverified').textContent, /does not declare what it waits on/)
  assert.ok([...root.querySelectorAll('.projects-tile')].some((node) => /Waits\s*unverified/.test(node.textContent)))
  window.projectsRender.renderProject(build({ 'proj.waiting_on': '' }, { unread: ['linked'] }), root, {})
  assert.match(root.querySelector('.projects-unverified').textContent, /could not be read/)
  const declared = build({ 'proj.waiting_on': '' })
  window.projectsRender.renderProject(declared, root, {})
  assert.equal(root.querySelector('.projects-unverified'), null)
  window.projectsRender.renderDashboard({ ...buildDashboard(structuredClone(fixture)), cards: [{ name: 'g', cards: [declared] }] }, root, {})
  assert.equal(root.querySelector('.projects-unverified'), null)
  window.projectsRender.renderNav({ ...buildDashboard(structuredClone(fixture)), cards: [{ name: 'g', cards: [undeclared, declared] }] }, root, {})
  const rows = [...root.querySelectorAll('.projects-nav-row')].map((node) => node.textContent)
  assert.equal(rows.filter((text) => /waits unverified/.test(text)).length, 1)
})

test('done projects leave the lead grids and sit in one closed archive at the end', (t) => {
  const { dom, root, model } = preview()
  t.after(() => dom.window.close())
  const opened = []
  dom.window.projectsRender.renderDashboard(model, root, { onOpenProject: (id, store) => opened.push([id, store]) })
  const cards = [...root.querySelectorAll('.projects-card')].map((node) => node.querySelector('h3').textContent)
  assert.ok(!cards.includes('Compass handoff'))
  assert.equal(cards.length, 5)
  const archive = root.querySelector('details.projects-archive')
  assert.equal(archive, root.lastElementChild)
  assert.equal(archive.open, false)
  assert.equal(archive.querySelector('summary').textContent, 'Done projects (1)')
  const row = archive.querySelector('.projects-nav-row')
  assert.match(row.textContent, /Compass handoff/)
  assert.match(row.textContent, /omni-evals-pl/)
  row.click()
  const done = model.cards.flatMap((group) => group.cards).find((card) => card.title === 'Compass handoff')
  assert.deepEqual(opened, [[done.id, done.store]])
})

test('a lead whose projects are all done gets no section, and no archive shows when nothing is done', (t) => {
  const { dom, window, root, model } = preview()
  t.after(() => dom.window.close())
  const all = model.cards.flatMap((group) => group.cards)
  const finished = all.find((card) => card.derivedState === 'done')
  const live = all.find((card) => card.derivedState !== 'done')
  window.projectsRender.renderDashboard({ ...model, cards: [{ lead: 'done-lead', cards: [finished] }, { lead: 'live-lead', cards: [live] }] }, root)
  const heads = [...root.querySelectorAll('section > h2')].map((node) => node.textContent)
  assert.ok(!heads.includes('done-lead'))
  assert.ok(heads.includes('live-lead'))
  window.projectsRender.renderDashboard({ ...model, cards: [{ lead: 'live-lead', cards: [live] }] }, root)
  assert.equal(root.querySelector('.projects-archive'), null)
})

test('the rail lists done projects only inside its closed archive', (t) => {
  const { dom, root } = navPreview()
  t.after(() => dom.window.close())
  const archive = root.querySelector('details.projects-archive')
  assert.equal(archive.open, false)
  assert.equal(archive.querySelector('summary').textContent, 'Done projects (1)')
  const outside = [...root.querySelectorAll('.projects-nav-row')].filter((node) => !archive.contains(node))
  assert.equal(outside.length, 5)
  assert.ok(outside.every((node) => !/Compass handoff/.test(node.textContent)))
  assert.match(archive.textContent, /Compass handoff/)
})

test('an archive she opened stays open when the minute refresh re-renders the view', (t) => {
  const { dom, window, root, model } = preview()
  t.after(() => dom.window.close())
  root.querySelector('.projects-archive').open = true
  window.projectsRender.renderDashboard(model, root)
  assert.equal(root.querySelector('.projects-archive').open, true)
  root.querySelector('.projects-archive').open = false
  window.projectsRender.renderDashboard(model, root)
  assert.equal(root.querySelector('.projects-archive').open, false)
  const rail = window.document.createElement('nav')
  window.projectsRender.renderNav(model, rail)
  rail.querySelector('.projects-archive').open = true
  window.projectsRender.renderNav(model, rail)
  assert.equal(rail.querySelector('.projects-archive').open, true)
})

test('a moving card face lists its started work by title with owner and checkpoint', (t) => {
  const { dom, root } = preview()
  t.after(() => dom.window.close())
  const face = root.querySelector('.projects-card-face')
  const evidence = [...face.querySelectorAll('.projects-evidence li')].map((item) => item.textContent)
  assert.ok(evidence.length > 0)
  assert.ok(evidence.every((line) => / · (claimed in progress|started \S+) · /.test(line)), evidence.join('\n'))
  assert.ok(evidence.some((line) => line.startsWith('Build catalog search · ')), evidence.join('\n'))
})

const pageFrom = (t, input, id) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(input.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const project = buildDashboard(input).cards.flatMap((group) => group.cards).find((entry) => entry.id === id)
  const root = window.document.querySelector('main')
  window.projectsRender.renderProject(project, root, {})
  return root
}

const milestoneInput = (changes) => {
  const input = structuredClone(fixture)
  for (const [id, metadata] of Object.entries(changes)) {
    const bead = input.milestones.find((entry) => entry.id === id)
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined) delete bead.metadata[key]
      else bead.metadata[key] = value
    }
  }
  return input
}

test('a dated milestone shows Due with its reason and an undated one shows no due line', (t) => {
  const root = pageFrom(t, milestoneInput({
    'fx-ms-1': { 'ms.target_reason': 'The vendor contract expires that day.' },
    'fx-ms-7': { 'ms.target': undefined },
  }), 'fx-project-1')
  const rows = Object.fromEntries([...root.querySelectorAll('li[title^="fx-ms-"]')].map((node) => [node.title, node.textContent]))
  assert.match(rows['fx-ms-1'], /Due 2026-11-02 · The vendor contract expires that day\./)
  assert.doesNotMatch(rows['fx-ms-7'], /due/i)
  assert.doesNotMatch(root.textContent, /no due date|false|undefined/i)
})

test('an undated next milestone is named without a due date', (t) => {
  const root = pageFrom(t, milestoneInput({ 'fx-ms-1': { 'ms.target': '' } }), 'fx-project-1')
  const progress = root.querySelector('.projects-progress').textContent
  assert.match(progress, /Next: Searchable catalog/)
  assert.doesNotMatch(progress, /due/i)
})

test('the next milestone line and the Dates entry both carry the date reason', (t) => {
  const root = pageFrom(t, milestoneInput({
    'fx-ms-1': { 'ms.target_reason': 'The vendor contract expires that day.' },
  }), 'fx-project-1')
  const progress = root.querySelector('.projects-progress').textContent
  assert.match(progress, /Next: Searchable catalog · due 2026-11-02 · The vendor contract expires that day\./)
  const due = [...root.querySelectorAll('li')].map((node) => node.textContent).find((line) => line.startsWith('Due: '))
  assert.match(due ?? '', /^Due: Searchable catalog · 2026-11-02 · deadline · The vendor contract expires that day\./)
})

test('each decision shows its escalation tier as a tag; an untiered one shows none and a bad one says so', (t) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const input = structuredClone(fixture)
  const ask = (id, tier) => ({ id, title: `Ask ${id}`, status: 'open', labels: ['needs/stephanie'],
    metadata: tier === undefined ? {} : { 'gc.tier': tier } })
  input.decisions = [ask('tier-one', '1'), ask('tier-two', 2), ask('tier-none'), ask('tier-bad', '7'), ask('tier-bool', true)]
  const model = buildDashboard(input)
  const root = window.document.querySelector('main')
  window.projectsRender.renderDashboard(model, root, {})
  const row = (id) => [...root.querySelectorAll('li')].find((node) => node.textContent.includes(`Ask ${id}`))
  const tags = (id) => [...row(id).querySelectorAll('.projects-tag')].map((node) => node.textContent)
  assert.ok(tags('tier-one').includes('Tier 1'))
  assert.ok(tags('tier-two').includes('Tier 2'))
  assert.ok(!tags('tier-none').some((tag) => /Tier/.test(tag)))
  assert.ok(tags('tier-bad').includes('Tier 7 is not 1-3'))
  assert.ok(tags('tier-bool').includes('Tier true is not 1-3'))
  assert.deepEqual(model.needsYou.map((entry) => entry.tier), ['Tier 1', 'Tier 2', '', 'Tier 7 is not 1-3', 'Tier true is not 1-3'])
})

test('an ask names who to answer: live seat is a button, sleeping or unknown seat is plain text', (t) => {
  const input = structuredClone(fixture)
  input.decisions = [
    { id: 'r1', title: 'Live ask', status: 'open', labels: ['needs/stephanie'], metadata: {}, created_by: 'omni-pl' },
    { id: 'r2', title: 'Asleep ask', status: 'open', labels: ['needs/stephanie'], metadata: { 'gc.owner': 'mayor' } },
    { id: 'r3', title: 'Unknown ask', status: 'open', labels: ['needs/stephanie'], metadata: { 'gc.owner': 'zz-seat' } },
    { id: 'r4', title: 'No owner ask', status: 'open', labels: ['needs/stephanie'], metadata: {} },
  ]
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = window.document.querySelector('main')
  const seats = []
  window.projectsRender.renderDashboard(buildDashboard(input), root, { onOpenSession: (seat) => seats.push(seat) })
  const row = (title) => [...root.querySelectorAll('li')].find((li) => li.textContent.includes(title))
  const live = row('Live ask')
  const button = [...live.querySelectorAll('button')].find((node) => node.textContent === "Open Verity's session")
  assert.ok(button)
  assert.equal(button.title, 'Open the omni-pl session')
  assert.match(live.textContent, /Owner: Verity \(omni-pl\)/)
  assert.doesNotMatch(live.textContent, /Answer to/)
  button.click()
  assert.deepEqual(seats, ['omni-pl'])
  const asleep = row('Asleep ask')
  assert.match(asleep.textContent, /Wren is asleep/)
  assert.match(asleep.textContent, /Owner: Wren \(mayor\)/)
  assert.equal([...asleep.querySelectorAll('button')].length, 1)
  assert.match(row('Unknown ask').textContent, /The zz-seat session is asleep/)
  assert.match(row('Unknown ask').textContent, /Owner: zz-seat/)
  assert.doesNotMatch(row('No owner ask').textContent, /Owner:|Answer to/)
})
