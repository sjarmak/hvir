const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const follow = require('../city-followups.js')

test('the store locator returns each routed store that is a city, as an absolute path', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pulls-follow-')))
  const rig = join(root, 'rig')
  for (const dir of ['rig/.beads', 'city/.beads', 'other-rig/.beads']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'city', 'city.toml'), '')
  writeFileSync(
    join(rig, '.beads', 'routes.jsonl'),
    [
      { prefix: 'om', path: '../city' },
      { prefix: 'x', path: '../other-rig' },
      { prefix: 'gone', path: '../missing' },
      { prefix: 'rig', path: '.' },
    ]
      .map((route) => JSON.stringify(route))
      .join('\n'),
  )
  const run = (cwd) =>
    follow.parseStores(execFileSync('sh', follow.locateArgs(), { cwd, encoding: 'utf8' }))
  assert.deepEqual(run(rig), [join(root, 'city')])
  assert.deepEqual(run(root), [])
  assert.deepEqual(follow.listArgs('/a/city').slice(0, 3), ['-C', '/a/city', 'list'])
  assert.throws(() => follow.listArgs('relative/city'), /absolute/)
})

const bead = (id, metadata, fields = {}) => ({
  id,
  title: id,
  status: 'open',
  updated_at: '2026-10-20T00:00:00Z',
  metadata,
  ...fields,
})

test('follow-ups group by pull request for this repository, newest first, with their kind', () => {
  const index = follow.indexFollowups(
    [
      bead('c1', { 'pr.number': '7', 'pr.repo': 'Acme/Widgets', 'pr.comment_ids': 'A,B,C' }, { status: 'deferred' }),
      bead(
        'ci1',
        { 'pr.number': '7', 'pr.repo': 'acme/widgets', 'pr.head_sha': 'f'.repeat(40) },
        { status: 'closed', updated_at: '2026-10-25T00:00:00Z' },
      ),
      bead('elsewhere', { 'pr.number': '7', 'pr.repo': 'other/repo', 'pr.comment_ids': 'Z' }),
      bead('bad', { 'pr.number': 'abc', 'pr.repo': 'acme/widgets' }),
      bead('note', { 'pr.number': 8 }),
    ],
    'acme/widgets',
  )
  assert.deepEqual([...index.keys()], [7, 8])
  const seven = index.get(7)
  assert.deepEqual(
    seven.map((item) => [item.id, item.kind, item.head, item.comments]),
    [
      ['ci1', 'ci', 'f'.repeat(40), 0],
      ['c1', 'comments', '', 3],
    ],
  )
  assert.equal(index.get(8)[0].kind, 'other')
  assert.deepEqual(follow.chip(seven), { label: 'City: 1 open follow-up', tone: 'warning' })
  assert.equal(follow.chip([seven[0]]), undefined)
})
