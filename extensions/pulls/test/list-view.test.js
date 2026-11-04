const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { JSDOM } = require('jsdom')

const SCRIPTS = ['guest-ui', 'view', 'business-time', 'pull-waits', 'pull-stacks', 'review-store', 'review-state',
  'city-reviews', 'city-followups', 'pulls-model']
const source = (name) => readFileSync(join(__dirname, '..', `${name}.js`), 'utf8')

const deferred = () => {
  let resolve
  const promise = new Promise((done) => (resolve = done))
  return { promise, resolve }
}

const snapshotFor = (repo, title) => ({
  repo, viewer: 'me', branch: 'main', branchPulls: [], authored: [], reviewRequested: [], hasMore: false, gitChecked: true,
  issues: [{ number: 1, title, url: `https://github.com/${repo}/issues/1`, state: 'open', author: 'me',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', labels: [], comments: 0 }],
})

function loadList(t) {
  const dom = new JSDOM(readFileSync(join(__dirname, '..', 'pulls.html'), 'utf8'), { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.hvirExtension = { onMessage: () => () => {}, send: () => {} }
  window.host = { availability: async () => ({ gh: 'supported', git: 'supported' }), request: async () => null }
  for (const name of SCRIPTS) window.eval(source(name))
  const page = { view: undefined, snapshots: new Map(), worktrees: deferred(), window }
  window.startView = (options) => ((page.view = options), { refresh: async () => {} })
  window.pullsSource = { snapshot: (workspace) => page.snapshots.get(workspace.id).promise }
  window.worktreeControl = { readWorktrees: () => page.worktrees.promise, worktreeFor: () => undefined }
  window.citySource = {}
  window.eval(source('pulls'))
  return page
}

const titles = (window) => [...window.document.querySelectorAll('.option-title')].map((node) => node.textContent)

test('the list paints when gh answers, before the worktree read finishes', async (t) => {
  const page = loadList(t)
  const workspace = { id: 'a', host: 'local' }
  page.snapshots.set('a', deferred())
  const loading = page.view.load({ workspace }, () => ({ workspace }))
  page.snapshots.get('a').resolve(snapshotFor('acme/a', 'First'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(titles(page.window), ['#1 First'])
  page.worktrees.resolve(new Map())
  await loading
  assert.deepEqual(titles(page.window), ['#1 First'])
})

test("a workspace's last list shows at once when it comes back, and another's rows never linger", async (t) => {
  const page = loadList(t)
  page.worktrees.resolve(new Map())
  const a = { id: 'a', host: 'local' }
  const b = { id: 'b', host: 'local' }
  let context = { workspace: a }
  const current = () => context
  page.snapshots.set('a', deferred())
  page.snapshots.get('a').resolve(snapshotFor('acme/a', 'From a'))
  await page.view.load(context, current)
  context = { workspace: b }
  page.snapshots.set('b', deferred())
  const loadingB = page.view.load(context, current)
  assert.deepEqual(titles(page.window), [])
  assert.equal(page.window.document.getElementById('status').textContent, 'Loading…')
  page.snapshots.get('b').resolve(snapshotFor('acme/b', 'From b'))
  await loadingB
  assert.deepEqual(titles(page.window), ['#1 From b'])
  context = { workspace: a }
  page.snapshots.set('a', deferred())
  const loadingA = page.view.load(context, current)
  assert.deepEqual(titles(page.window), ['#1 From a'])
  assert.equal(page.window.document.getElementById('repo').textContent, 'acme/a')
  page.snapshots.get('a').resolve(snapshotFor('acme/a', 'From a, refreshed'))
  await loadingA
  assert.deepEqual(titles(page.window), ['#1 From a, refreshed'])
})
