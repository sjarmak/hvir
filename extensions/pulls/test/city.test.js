const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const city = require('../city-reviews.js')

const bead = (id, metadata, fields = {}) => ({
  id,
  title: id,
  status: 'closed',
  updated_at: '2026-10-20T00:00:00Z',
  metadata,
  ...fields,
})

test('city beads join pull requests by review number, pr.number, pr.url or head branch, only for this repository', () => {
  const reviews = [
    bead('r1', {
      'pr.review_number': 10,
      'pr.repo': 'Acme/Widgets',
      'pr.review_verdict': 'fail',
      'pr.review_blocking': 2,
    }),
    bead('r2', { 'pr.review_number': 10, 'pr.repo': 'other/repo' }),
    bead(
      'r3',
      { 'pr.review_number': 10, 'pr.repo': 'acme/widgets', 'pr.review_verdict': 'pass' },
      { updated_at: '2026-10-25T00:00:00Z' },
    ),
  ]
  const authored = [
    bead('a1', { 'pr.number': 11, 'pr.repo': 'acme/widgets' }),
    bead('a2', {
      'pr.url': 'https://github.com/acme/widgets/pull/12',
      'pr.repo': 'acme/widgets',
      'pr.review_verdict': 'pass',
    }),
    bead('a3', { 'pr.head_branch': 'feat/x', 'pr.repo': 'acme/widgets' }),
  ]
  const index = city.indexBeads(reviews, authored, 'acme/widgets')
  const ids = (number, headRef = 'none') =>
    city.runsFor(index, { number, headRef }).map((run) => run.id)
  assert.deepEqual(ids(10), ['r3', 'r1'])
  assert.deepEqual(ids(11), ['a1'])
  assert.deepEqual(ids(12), ['a2'])
  assert.deepEqual(ids(13, 'feat/x'), ['a3'])
  assert.deepEqual(city.chip(city.runsFor(index, { number: 10, headRef: '' })), {
    label: 'City review: pass',
    tone: 'success',
  })
  const [failed] = city.runsFor(city.indexBeads([reviews[0]], [], 'acme/widgets'), {
    number: 10,
    headRef: '',
  })
  assert.deepEqual(city.chip([failed]), {
    label: 'City review: fail · 2 blocking',
    tone: 'danger',
  })
  assert.equal(city.chip([]), undefined)
})

test('a run reports the most specific reviewed commit and leaves unrecorded provenance empty', () => {
  const index = city.indexBeads(
    [
      bead('r1', {
        'pr.review_number': 5,
        'pr.gate_sha': 'g'.repeat(40),
        'pr.head_sha': 'h'.repeat(40),
        'gc.execution_routed_to': 'omni-pl',
      }),
    ],
    [],
    'acme/widgets',
  )
  const [run] = city.runsFor(index, { number: 5, headRef: '' })
  assert.equal(run.reviewedHead, 'g'.repeat(40))
  assert.equal(run.seat, 'omni-pl')
  assert.deepEqual([run.formula, run.reviewedAt, run.lanes], ['', '', ''])
})

const PACKAGE = {
  'findings.json': {
    head_sha: 'abc',
    findings: [
      {
        id: 'f1',
        severity: 'blocking',
        title: 'Leak',
        file: 'a.ts',
        line: 7,
        lanes: ['codex'],
        evidence: 'why',
      },
      {
        id: 'f2',
        severity: 'suggestion',
        title: 'Doc',
        file: 'b.md',
        line: 0,
        lanes: [],
      },
    ],
  },
  'posted.json': {
    entries: [
      { kind: 'inline', finding: 'f1', url: 'https://x/c1' },
      { kind: 'pr-level', finding: null, url: 'https://x/c0' },
    ],
  },
  'gate.json': { result: 'pass', checks: [{ id: 'H1', ok: true }] },
  'reviews/round-1/opus.json': {
    lane_id: 'opus',
    model: 'claude-opus-5-5',
    verdict: 'pass',
    blocking_count: 0,
    findings: [],
  },
  'reviews/round-2/codex.json': {
    lane_id: 'codex',
    model: 'GPT-6',
    verdict: 'fail',
    blocking_count: 1,
    findings: [{}],
    summary: 's',
  },
  'reviews/round-2/fable.json': {
    lane_id: 'fable',
    model: 'claude-fable-5-1',
    verdict: 'pass_with_findings',
    findings: [{}, {}],
  },
}

function writePackage(home) {
  const dir = join(home, 'city', '.gc', 'pr-pipeline', 'omni-x1')
  for (const [name, value] of Object.entries(PACKAGE)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2))
  }
  mkdirSync(join(dir, 'reviews', 'round-3'), { recursive: true })
  writeFileSync(join(dir, 'reviews', 'round-3', 'broken.json'), '{ not json')
  return dir
}

test('a review package on disk reads into rounds newest first, findings with their posted links, and the gate', () => {
  const home = mkdtempSync(join(tmpdir(), 'pulls-city-'))
  const dir = writePackage(home)
  const stdout = execFileSync('sh', city.packageArgs(dir), {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  })
  const pkg = city.parsePackage(stdout)
  assert.equal(pkg.head, 'abc')
  assert.deepEqual(
    pkg.rounds.map((round) => [
      round.round,
      round.lanes.map(
        (lane) => `${lane.lane}:${lane.model}:${lane.verdict}:${lane.findings}`,
      ),
    ]),
    [
      [3, ['broken:::0']],
      [2, ['codex:GPT-6:fail:1', 'fable:claude-fable-5-1:pass_with_findings:2']],
      [1, ['opus:claude-opus-5-5:pass:0']],
    ],
  )
  assert.match(pkg.rounds[0].lanes[0].unreadable, /JSON/)
  assert.deepEqual(
    pkg.findings.map((finding) => [finding.id, finding.line, finding.postedUrl]),
    [
      ['f1', 7, 'https://x/c1'],
      ['f2', 0, undefined],
    ],
  )
  assert.equal(pkg.gate.result, 'pass')
  assert.deepEqual(
    pkg.posted.map((entry) => entry.url),
    ['https://x/c1', 'https://x/c0'],
  )
  assert.deepEqual([...city.findingsByFile(pkg.findings).keys()], ['a.ts', 'b.md'])
})

test('the package reader refuses paths outside a city pipeline directory, in JavaScript and in the shell', () => {
  for (const path of [
    '/etc',
    '/x/.gc/pr-pipeline/../../etc',
    'relative/.gc/pr-pipeline/a',
    '/x/.gc/pr-pipeline/a/b',
  ])
    assert.throws(() => city.packageArgs(path), /Not a city pipeline package/)
  const home = mkdtempSync(join(tmpdir(), 'pulls-city-'))
  const [, script] = city.packageArgs('/x/.gc/pr-pipeline/a')
  const run = (dir) =>
    execFileSync('sh', ['-c', script, 'sh', dir], {
      env: { HOME: home, PATH: process.env.PATH },
      encoding: 'utf8',
      stdio: 'pipe',
    })
  assert.throws(() => run('/tmp/.gc/pr-pipeline/a'), /not a city pipeline package/)
  assert.throws(() => run(`${home}/c/.gc/pr-pipeline/../../../etc`), /has \.\./)
  assert.equal(run(`${home}/c/.gc/pr-pipeline/missing`), '')
})
