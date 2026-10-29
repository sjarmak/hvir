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
