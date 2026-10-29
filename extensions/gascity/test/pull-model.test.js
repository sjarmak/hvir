const { test } = require('node:test')
const assert = require('node:assert/strict')
const { target, prArgs, checks, checksLine, metaLine, recordLine } = require('../pull-model.js')

test('a PR target needs owner/name and a positive whole number', () => {
  assert.deepEqual(target({ repo: 'exploreomni/omni', number: 71339 }), { repo: 'exploreomni/omni', number: 71339 })
  for (const input of [undefined, {}, { repo: 'a/b', number: 0 }, { repo: 'a/b', number: '7' }, { repo: 'a/b;x', number: 7 },
    { repo: 'a/b/c', number: 7 }, { repo: 'a/b', number: 1.5 }])
    assert.equal(target(input), null, JSON.stringify(input))
})

test('the connector gets exactly --repo, --number and --json', () => {
  assert.deepEqual(prArgs({ repo: 'a/b', number: 7 }), ['--repo', 'a/b', '--number', '7', '--json'])
})

test('checks count check runs and status contexts, listing the failures', () => {
  const summary = checks([
    { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'build', status: 'IN_PROGRESS', conclusion: '' },
    { name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { context: 'ci/legacy', state: 'ERROR' },
    { context: 'ci/ok', state: 'SUCCESS' },
  ])
  assert.deepEqual(summary, { passed: 2, failed: 2, pending: 1, skipped: 1, total: 6, failing: ['test', 'ci/legacy'] })
  assert.equal(checksLine(summary), '2 passed · 2 failed · 1 pending · 1 skipped')
  assert.equal(checksLine(checks(undefined)), 'No checks')
})

test('the meta line names repo, state, author, review, branches and size', () => {
  const pull = { number: 7, state: 'OPEN', isDraft: false, author: { login: 'sjarmak' }, reviewDecision: 'REVIEW_REQUIRED',
    headRefName: 'sjarmak/x', baseRefName: 'main', additions: 3, deletions: 1, changedFiles: 2 }
  assert.equal(metaLine(pull, 'a/b'), 'a/b#7 · open · sjarmak · Review required · sjarmak/x → main · +3 −1 in 2 files')
  assert.match(metaLine({ ...pull, isDraft: true }, 'a/b'), /^a\/b#7 · draft · /)
})

test('the review record says whether it covers the current head', () => {
  const head = 'a'.repeat(40)
  const record = { id: 'omni-1', 'pr.review_verdict': 'pass', 'pr.review_blocking': 0, 'pr.review_round': 2,
    'pr.review_counts': 'blocking=0,important=1,suggestion=0', 'pr.head_sha': head }
  assert.equal(recordLine(record, head),
    'City review round 2: pass · 0 blocking · blocking=0,important=1,suggestion=0 · at the current head aaaaaaaaaaaa · omni-1')
  assert.match(recordLine(record, 'b'.repeat(40)), /at aaaaaaaaaaaa, an older head \(the PR moved since\)/)
  assert.equal(recordLine(null, head), 'No city review record for this PR.')
  assert.match(recordLine({ id: 'omni-2' }, head), /^City review: no verdict · head unknown · omni-2$/)
})
