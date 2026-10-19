const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseClassification,
  parseLabelLog,
  labelLogBatches,
  commitLabelRows,
  labelChips,
  labelSummary,
  isPartialClone,
  LABEL_BATCH,
} = require('../commit-labels.js')

const sha = (digit) => digit.repeat(40)
const record = (hash, trailers, note) => `\x1e${hash}\x1f${trailers}\x1f${note}\x1f`

test('trailers parse with case-insensitive keys, first value wins, beads collect', () => {
  const label = parseClassification(
    'CHANGE-TYPE: feat\nchange-scope: pulls\nArchitectural: Architectural\nRISK: high\nBead: hvir-1\nbead: hvir-2\nChange-Type: fix\nClassified-By: fleet',
  )
  assert.deepEqual(label, {
    type: 'feat',
    scope: 'pulls',
    architectural: 'Architectural',
    risk: 'high',
    beads: ['hvir-1', 'hvir-2'],
    classifiedBy: 'fleet',
  })
})

test('a text without Change-Type is no classification, even with other keys', () => {
  assert.equal(parseClassification('Risk: high\nArchitectural: architectural'), undefined)
  assert.equal(parseClassification(''), undefined)
})

test('continuation lines fold into the previous trailer; a blank line ends it', () => {
  const label = parseClassification('Change-Type: refactor\nRisk: medium\n  with follow-up\n\n  stray')
  assert.equal(label.risk, 'medium with follow-up')
})

test('empty, overlong and control-character values are dropped', () => {
  assert.equal(parseClassification(`Change-Type: ${'x'.repeat(201)}`), undefined)
  assert.equal(parseClassification('Change-Type:   '), undefined)
  assert.equal(parseClassification('Change-Type: fe\u0007at'), undefined)
  assert.equal(parseClassification(`Change-Type: ${'y'.repeat(200)}`).type.length, 200)
})

test('a note replaces the message trailers; an absent note falls back to trailers', () => {
  const output = [
    record(sha('a'), 'Change-Type: feat\n', 'Change-Type: fix\nArchitectural: architectural\n'),
    record(sha('b'), 'Change-Type: docs\n', ''),
    record(sha('c'), 'Change-Type: chore\n', 'unrelated note\n'),
    record(sha('d'), 'Signed-off-by: someone\n', ''),
  ].join('\n')
  const found = parseLabelLog(output)
  assert.deepEqual([...found.keys()], [sha('a'), sha('b'), sha('c'), sha('d')])
  assert.equal(found.get(sha('a')).type, 'fix')
  assert.equal(found.get(sha('a')).architectural, 'architectural')
  assert.equal(found.get(sha('b')).type, 'docs')
  assert.equal(found.get(sha('c')), undefined)
  assert.equal(found.get(sha('d')), undefined)
})

test('records with a malformed hash are ignored', () => {
  assert.equal(parseLabelLog(record('not-a-sha', 'Change-Type: feat', '')).size, 0)
})

test('batches stay within the git connector argument bounds and end each with --', () => {
  const shas = Array.from({ length: LABEL_BATCH * 2 + 3 }, (_, i) => i.toString(16).padStart(40, '0'))
  const batches = labelLogBatches(shas, false)
  assert.equal(batches.length, 3)
  for (const args of batches) {
    assert.ok(args.length <= 128)
    assert.ok(new TextEncoder().encode(JSON.stringify(args)).length <= 8192)
    assert.equal(args.at(-1), '--')
    assert.ok(args.includes('--ignore-missing'))
    assert.ok(args.includes('--notes=refs/notes/classification'))
  }
  assert.deepEqual(batches.flatMap((args) => args.filter((arg) => /^[0-9a-f]{40}$/.test(arg))), shas)
})

test('an invalid commit id from gh is rejected rather than passed to git', () => {
  assert.throws(() => labelLogBatches(['--output=/tmp/x'], false), /invalid commit id/)
})

test('rows mark commits missing from the checkout and the summary counts them', () => {
  const commits = [
    { oid: sha('a'), messageHeadline: 'one' },
    { oid: sha('b'), messageHeadline: 'two' },
    { oid: sha('e'), messageHeadline: 'three' },
  ]
  const found = new Map([
    [sha('a'), { type: 'feat', architectural: 'ARCHITECTURAL', risk: 'low', beads: [] }],
    [sha('b'), undefined],
  ])
  const rows = commitLabelRows(commits, found)
  assert.deepEqual(rows.map((row) => row.state), ['labeled', 'unlabeled', 'missing'])
  assert.equal(rows[0].short, 'aaaaaaa')
  assert.equal(labelSummary(rows), '1 of 3 commits marked architectural · 1 not in this checkout')
})

test('chips show type, scope, architectural only when marked, and risk', () => {
  assert.deepEqual(labelChips({ type: 'feat', scope: 'ui', architectural: 'Architectural', risk: 'high', beads: [] }), [
    'feat',
    'scope: ui',
    'architectural',
    'risk: high',
  ])
  assert.deepEqual(labelChips({ type: 'fix', architectural: 'none', beads: [] }), ['fix'])
})

test('with no labels anywhere the summary is one quiet line', () => {
  const rows = commitLabelRows([{ oid: sha('a'), messageHeadline: 'one' }], new Map([[sha('a'), undefined]]))
  assert.equal(labelSummary(rows), 'No change-type labels on 1 commit')
  const missing = commitLabelRows([{ oid: sha('a'), messageHeadline: 'one' }], new Map())
  assert.equal(labelSummary(missing), 'No change-type labels on 1 commit · 1 not in this checkout')
})

test('a partial clone is recognized from config names, so git log will not fetch missing commits', () => {
  assert.equal(isPartialClone('core.bare\nremote.origin.url\nremote.origin.promisor\n'), true)
  assert.equal(isPartialClone('core.bare\nEXTENSIONS.PARTIALCLONE\n'), true)
  assert.equal(isPartialClone('core.bare\nremote.origin.url\nremote.origin.partialclonefilterx\n'), false)
  const [args] = labelLogBatches(['a'.repeat(40)], true)
  assert.equal(args[0], '--no-lazy-fetch')
  assert.equal(args[1], 'log')
  assert.equal(labelLogBatches(['a'.repeat(40)], false)[0][0], 'log')
})
