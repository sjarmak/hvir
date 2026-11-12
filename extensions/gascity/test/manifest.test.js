const { test } = require('node:test')
const assert = require('node:assert/strict')
const manifest = require('../hvir-extension.json')

/** hvir rejects the whole package past these (src/shared/extensions/connectors.ts, contributions.ts). */
const CONNECTOR_DESCRIPTION = 240
const ACTION_DESCRIPTION = 500

test('connector and action descriptions fit hvir manifest limits', () => {
  for (const connector of [...(manifest.connectors ?? []), ...(manifest.actionConnectors ?? [])])
    assert.ok(
      connector.description.length <= CONNECTOR_DESCRIPTION,
      `${connector.id}: ${connector.description.length} chars`,
    )
  for (const action of manifest.actions ?? [])
    assert.ok(
      action.description.length <= ACTION_DESCRIPTION,
      `${action.id}: ${action.description.length} chars`,
    )
})

test('the only rail item is the header city item, with no per-session updater', () => {
  assert.deepEqual(
    (manifest.railItems ?? []).map((item) => item.id),
    ['city'],
  )
  assert.equal(manifest.updater, undefined)
  const fs = require('node:fs')
  const path = require('node:path')
  for (const file of ['updater.html', 'updater.js'])
    assert.equal(fs.existsSync(path.join(__dirname, '..', file)), false, `${file} still exists`)
})

test('the Projects view is in the left navigation and its entry exists', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const view = (manifest.views ?? []).find((item) => item.id === 'projects')
  assert.equal(view?.navigation, 'left')
  assert.ok(fs.existsSync(path.join(__dirname, '..', view.entry)), `${view.entry} is missing`)
})

test('the project page is a tab view outside the rail, its entry present, within the eight-view limit', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const view = (manifest.views ?? []).find((item) => item.id === 'project')
  assert.equal(view?.navigation, undefined)
  assert.ok(fs.existsSync(path.join(__dirname, '..', view.entry)), `${view.entry} is missing`)
  assert.ok(manifest.views.length <= 8, `${manifest.views.length} views; hvir accepts at most eight`)
})

test('Gas City has one left-nav entry, shown as a city icon, and no Beads, Needs you or City tabs', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const nav = (manifest.views ?? []).filter((item) => item.navigation)
  assert.deepEqual(nav.map((item) => item.id), ['projects'])
  assert.equal(nav[0].title, 'Gas City')
  assert.ok(fs.existsSync(path.join(__dirname, '..', nav[0].navigationIcon)))
  assert.equal((manifest.views ?? []).some((item) => ['beads', 'needs'].includes(item.id)), false)
})

test('a PR opens a copy of the Pull requests pull view, with the actions it launches', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const views = Object.fromEntries((manifest.views ?? []).map((item) => [item.id, item]))
  assert.equal(views.pull?.entry, 'pr/pull.html')
  assert.equal(views['pr-actions']?.entry, 'pr/pulls.html')
  for (const view of [views.pull, views['pr-actions']]) assert.equal(view.navigation, undefined)
  assert.deepEqual((manifest.actions ?? []).map((item) => [item.id, item.view, item.agents]), [
    ['answer-decision', 'projects', false],
    ['checkout-terminal', 'pr-actions', false],
    ['worktree-terminal', 'pr-actions', false],
    ['pull-worktree-terminal', 'pr-actions', false],
    ['attach-session', 'city', false],
    ['attach-seat', 'projects', false],
  ])
  assert.equal((manifest.connectors ?? []).some((item) => item.id === 'city-pr'), false)
  const data = fs.readFileSync(path.join(__dirname, '..', 'projects-data.js'), 'utf8')
  assert.match(data, /window\.openOwn\('pull', \{ repo: `\$\{ref\.owner\}\/\$\{ref\.repo\}`, number: ref\.number \}\)/)
  assert.doesNotMatch(data, /openOwn\('session'/)
})

test('hvir-answer is an action connector with no setup hint and describes itself in plain words', () => {
  const connectors = manifest.connectors ?? []
  assert.equal(connectors.length, 6)
  assert.equal(connectors.some((item) => item.id === 'hvir-answer'), false)
  const answer = (manifest.actionConnectors ?? []).find((item) => item.id === 'hvir-answer')
  assert.equal(manifest.actionConnectors.length, 1)
  assert.equal(answer.setup, undefined)
  assert.equal(answer.context, 'workspace')
  assert.ok(answer.description.length <= CONNECTOR_DESCRIPTION)
  assert.match(answer.description, /answer/i)
  assert.ok(connectors.filter((item) => item.setup).length <= 4)
})

test('connector.action-binding is an optional capability, not a required one', () => {
  assert.ok(manifest.optionalCapabilities.includes('connector.action-binding'))
  assert.equal(manifest.requiredCapabilities.includes('connector.action-binding'), false)
})

test('the answer action is for people only, on the Gas City view, and its input is a bare three-field object', () => {
  const action = (manifest.actions ?? []).find((item) => item.id === 'answer-decision')
  assert.equal(action.agents, false)
  assert.equal(action.view, 'projects')
  assert.ok((manifest.actions ?? []).length <= 16)
  assert.deepEqual(action.inputSchema.required, ['decId', 'letter', 'cardSha256'])
  assert.equal(action.inputSchema.additionalProperties, false)
  const supported = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'maxLength', 'maxItems']
  for (const schema of [action.inputSchema, ...Object.values(action.inputSchema.properties)])
    for (const key of Object.keys(schema)) assert.ok(supported.includes(key), `${key} is not an hvir schema key`)
})

test('the copied pull view and its connectors match the Pull requests extension', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const copy = path.join(__dirname, '..', 'pr')
  const original = path.join(__dirname, '..', '..', 'pulls')
  const files = (dir) => fs.readdirSync(dir, { recursive: true }).filter((file) => fs.statSync(path.join(dir, file)).isFile())
  for (const file of files(copy))
    assert.ok(fs.readFileSync(path.join(copy, file)).equals(fs.readFileSync(path.join(original, file))), `pr/${file} differs from pulls/${file}`)
  const references = [
    [/(?:src|href)="([^"]+)"/g, (file) => file.endsWith('.html')],
    [/@import\s+['"]([^'"]+)['"]/g, (file) => file.endsWith('.css')],
  ]
  for (const [pattern, applies] of references)
    for (const file of files(copy).filter(applies))
      for (const [, asset] of fs.readFileSync(path.join(copy, file), 'utf8').matchAll(pattern))
        assert.ok(fs.existsSync(path.join(copy, path.dirname(file), asset)), `pr/${file} needs ${asset}`)
  const pulls = require('../../pulls/hvir-extension.json')
  const withoutSetup = ({ setup, ...rest }) => rest
  for (const id of ['gh', 'git', 'shell'])
    assert.deepEqual(withoutSetup(manifest.connectors.find((item) => item.id === id)), withoutSetup(pulls.connectors.find((item) => item.id === id)))
  assert.ok(manifest.connectors.filter((item) => item.setup).length <= 4, 'hvir allows at most four setup hints')
})

test('the hvir-answer connector is bound to the agents-false answer-decision action', () => {
  const connector = manifest.actionConnectors.find((item) => item.id === 'hvir-answer')
  assert.deepEqual(connector.actions, ['answer-decision'])
  const action = manifest.actions.find((item) => item.id === 'answer-decision')
  assert.equal(action.agents, false)
  for (const other of manifest.connectors) assert.equal(other.actions, undefined, `${other.id} must stay unbound`)
})
