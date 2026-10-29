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
  assert.equal(root.querySelectorAll('.projects-card').length, 6)
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
  assert.equal(root.textContent.match(/not updated in 24h/g).length, 1)
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
  assert.equal(root.querySelectorAll('.projects-card').length, 6)
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
  assert.equal(document.querySelectorAll('.projects-card').length, 6)
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
