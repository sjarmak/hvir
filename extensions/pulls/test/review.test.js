const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { parseDiff, commentTarget } = require('../diff-parse.js')
const store = require('../review-store.js')
const review = require('../review-state.js')
const { validate, submitReview } = require('../review-submit.js')

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,4 +10,5 @@ function main() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' return a',
  '\\ No newline at end of file',
  'diff --git a/old name.txt b/new name.txt',
  'similarity index 100%',
  'rename from old name.txt',
  'rename to new name.txt',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'Binary files /dev/null and b/logo.png differ',
  'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
  'deleted file mode 100644',
  '--- "a/caf\\303\\251.md"',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  '',
].join('\n')

test('a unified diff parses into files with numbered lines, renames, binaries and quoted paths', () => {
  const files = parseDiff(DIFF)
  assert.deepEqual(
    files.map((file) => [
      file.path,
      file.status,
      file.additions,
      file.deletions,
      file.binary,
    ]),
    [
      ['src/app.js', 'modified', 2, 1, false],
      ['new name.txt', 'renamed', 0, 0, false],
      ['logo.png', 'added', 0, 0, true],
      ['café.md', 'deleted', 0, 1, false],
    ],
  )
  assert.equal(files[1].oldPath, 'old name.txt')
  const lines = files[0].hunks[0].lines
  assert.deepEqual(
    lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    [
      ['context', 10, 10],
      ['del', 11, undefined],
      ['add', undefined, 11],
      ['add', undefined, 12],
      ['context', 12, 13],
      ['meta', undefined, undefined],
    ],
  )
  assert.deepEqual(lines.map(commentTarget), [
    { side: 'RIGHT', line: 10 },
    { side: 'LEFT', line: 11 },
    { side: 'RIGHT', line: 11 },
    { side: 'RIGHT', line: 12 },
    { side: 'RIGHT', line: 13 },
    undefined,
  ])
})

test('a file hash changes when its patch changes and not when another file does', () => {
  const [before] = parseDiff(DIFF)
  const [after] = parseDiff(DIFF.replace('+const c = 4', '+const c = 5'))
  const [, renamedBefore] = parseDiff(DIFF)
  const [, renamedAfter] = parseDiff(DIFF.replace('+const c = 4', '+const c = 5'))
  assert.notEqual(before.hash, after.hash)
  assert.equal(renamedBefore.hash, renamedAfter.hash)
})

test('a reviewed tick lapses when the file changes, and next unread wraps past reviewed files', () => {
  const files = parseDiff(DIFF)
  let state = review.fromListing(new Map(), 'Acme/Widgets', 7)
  state = review.withRead(state, files[0], true)
  state = review.withRead(state, files[2], true)
  assert.deepEqual(review.progress(state, files), { read: 2, total: 4 })
  assert.equal(review.nextUnread(state, files, files[2].path).path, 'café.md')
  assert.equal(review.nextUnread(state, files, files[3].path).path, 'new name.txt')
  const changed = parseDiff(DIFF.replace('+const c = 4', '+const c = 5'))
  assert.equal(review.isRead(state, changed[0]), false)
  assert.equal(review.isRead(review.withRead(state, files[0], false), files[0]), false)
})

test('a saved listing restores the review and its valid drafts and counts the unreadable ones', () => {
  const repo = 'Acme/Widgets'
  const entries = new Map([
    [
      store.reviewName(repo, 7),
      { read: { 'a.js': 'abc', bad: 3 }, summary: 'ok', event: 'APPROVE' },
    ],
    [
      store.draftName(repo, 7, 'b2'),
      { path: 'b.js', line: 4, side: 'RIGHT', body: 'second', commit: 'f00' },
    ],
    [
      store.draftName(repo, 7, 'a1'),
      { path: 'a.js', line: 9, side: 'LEFT', body: 'first' },
    ],
    [
      store.draftName(repo, 7, 'zz'),
      { path: 'a.js', line: 0, side: 'RIGHT', body: 'bad line' },
    ],
    [
      store.draftName(repo, 8, 'c3'),
      { path: 'c.js', line: 1, side: 'RIGHT', body: 'other pull' },
    ],
  ])
  const state = review.fromListing(entries, repo, 7)
  assert.deepEqual(state.read, { 'a.js': 'abc' })
  assert.equal(state.event, 'APPROVE')
  assert.deepEqual(
    state.drafts.map((draft) => [draft.id, draft.path, draft.commit]),
    [
      ['a1', 'a.js', ''],
      ['b2', 'b.js', 'f00'],
    ],
  )
  assert.equal(state.skipped, 1)
  const byNumber = review.repoProgress(entries, repo)
  assert.deepEqual(byNumber.get(7), { read: { 'a.js': 'abc' }, drafts: 2 })
  assert.deepEqual(byNumber.get(8), { read: {}, drafts: 1 })
})

test('store names never let one repository or pull request read another one', () => {
  assert.equal(store.pullPrefix('Acme/Widgets', 7), 'acme__widgets+7+')
  assert.equal(
    store.reviewName('acme/widgets', 7).startsWith(store.pullPrefix('acme/widgets', 70)),
    false,
  )
  assert.equal(
    store.draftName('acme/w', 1, 'x').startsWith(store.repoPrefix('acme/w--x')),
    false,
  )
  assert.throws(() => store.listArgs('../etc'), /Invalid review store name/)
  assert.throws(() => store.writeArgs('.hidden', {}), /Invalid review store name/)
  assert.throws(
    () => store.writeArgs('ok', { body: 'x'.repeat(store.MAX_VALUE_BYTES) }),
    /Too large to save/,
  )
})

test('the store script round-trips writes, lists by prefix and removes, all under one directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'pulls-store-'))
  const sh = (args) =>
    execFileSync('sh', args, {
      env: { HOME: home, PATH: process.env.PATH },
      encoding: 'utf8',
    })
  const drafts = [
    store.draftName('acme/w', 3, 'a'),
    store.draftName('acme/w', 3, 'b'),
    store.draftName('acme/w', 30, 'c'),
  ]
  sh(store.writeArgs(drafts[0], { body: 'tab\there "quoted" $HOME `x`' }))
  sh(store.writeArgs(drafts[1], { body: 'second' }))
  sh(store.writeArgs(drafts[2], { body: 'other' }))
  const listed = store.parseListing(sh(store.listArgs(store.pullPrefix('acme/w', 3))))
  assert.deepEqual([...listed.keys()].sort(), [drafts[0], drafts[1]])
  assert.equal(listed.get(drafts[0]).body, 'tab\there "quoted" $HOME `x`')
  sh(store.removeArgs(drafts[0]))
  assert.deepEqual(
    [...store.parseListing(sh(store.listArgs(store.repoPrefix('acme/w')))).keys()].sort(),
    [drafts[1], drafts[2]],
  )
  assert.deepEqual(readdirSync(join(home, '.hvir', 'pulls')).sort(), [
    `${drafts[1]}.json`,
    `${drafts[2]}.json`,
  ])
  assert.equal(sh(store.listArgs(store.repoPrefix('nobody/here'))), '')
})

test('review validation follows GitHub: summaries for request changes, something to say for a comment', () => {
  const base = { event: 'COMMENT', summary: '', drafts: [], isAuthor: false }
  assert.match(validate(base), /summary or at least one line comment/)
  assert.equal(validate({ ...base, pendingComments: 2 }), undefined)
  assert.equal(validate({ ...base, event: 'APPROVE' }), undefined)
  assert.match(validate({ ...base, event: 'REQUEST_CHANGES' }), /needs a summary/)
  assert.match(
    validate({ ...base, event: 'APPROVE', isAuthor: true }),
    /own pull request/,
  )
  assert.match(validate({ ...base, drafts: [{ body: '  ' }] }), /empty/)
})

const fieldsOf = (args) =>
  Object.fromEntries(
    args.flatMap((arg, index) =>
      ['-f', '-F'].includes(args[index - 1]) ? [arg.split(/=(.*)/s).slice(0, 2)] : [],
    ),
  )

test('submitting starts a pending review, adds each draft as a thread, then submits the chosen event', async () => {
  const calls = []
  const posted = []
  const responses = [
    { data: { addPullRequestReview: { pullRequestReview: { id: 'R1' } } } },
    { data: { addPullRequestReviewThread: { thread: { id: 'T1' } } } },
    { data: { addPullRequestReviewThread: { thread: { id: 'T2' } } } },
    {
      data: {
        submitPullRequestReview: {
          pullRequestReview: { url: 'https://x/r', state: 'APPROVED' },
        },
      },
    },
  ]
  const result = await submitReview({
    run: async (args) => {
      calls.push(fieldsOf(args))
      return responses[calls.length - 1]
    },
    pull: { id: 'PR1', headRefOid: 'a'.repeat(40) },
    drafts: [
      { id: 'd1', path: 'a.js', line: 3, side: 'RIGHT', body: '@team -F looks off' },
      { id: 'd2', path: 'b.js', line: 9, side: 'LEFT', body: 'why?' },
    ],
    event: 'APPROVE',
    summary: 'Ship it',
    onStarted: (id) => posted.push(`started ${id}`),
    onPosted: (draft) => posted.push(draft.id),
  })
  assert.deepEqual(result, { url: 'https://x/r', state: 'APPROVED' })
  assert.deepEqual(posted, ['started R1', 'd1', 'd2'])
  assert.equal(calls[0].pull, 'PR1')
  assert.equal(calls[0].commit, 'a'.repeat(40))
  assert.deepEqual(
    [calls[1].review, calls[1].path, calls[1].line, calls[1].side, calls[1].body],
    ['R1', 'a.js', '3', 'RIGHT', '@team -F looks off'],
  )
  assert.deepEqual(
    [calls[3].review, calls[3].event, calls[3].body],
    ['R1', 'APPROVE', 'Ship it'],
  )
})

test('submitting reuses an existing pending review and stops at the first GraphQL error', async () => {
  const calls = []
  await assert.rejects(
    submitReview({
      run: async (args) => {
        calls.push(fieldsOf(args))
        return { errors: [{ message: 'Line could not be resolved' }] }
      },
      pull: { id: 'PR1', headRefOid: 'b'.repeat(40) },
      pendingReviewId: 'R9',
      drafts: [{ id: 'd1', path: 'a.js', line: 3, side: 'RIGHT', body: 'x' }],
      event: 'COMMENT',
      summary: '',
    }),
    /Line could not be resolved/,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].review, 'R9')
})
