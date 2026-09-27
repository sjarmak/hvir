import { expect, it } from 'vitest'
import {
  describeCommits,
  describeHistoryRange,
  describeShownCommit,
  endsFromText,
  historyRange,
  historyRangeEnds,
  lockedBaseline,
  stripEnds,
  stripPosition,
  stripStep,
} from '../src/renderer/src/architecture-review/architecture-ends-model'
import type { ArchitectureCommitRange } from '../src/shared/architecture-review'
import type { GitCommitSummary } from '../src/shared/git-types'

const commit = (revision: string, parent: string | null) => ({
  revision,
  parent,
  merge: false,
  subject: `subject ${revision}`,
  authoredAt: '2026-09-26T10:00:00+00:00',
})
const range: ArchitectureCommitRange = {
  base: commit('b', 'z'),
  commits: [commit('c3', 'c2'), commit('c2', 'c1'), commit('c1', 'b')],
  truncated: false,
}

it('steps pairwise from each commit to its first parent by default', () => {
  expect(stripEnds(range, 2, { kind: 'pairwise' })).toEqual({
    baseline: 'b',
    current: 'c1',
  })
  expect(stripEnds(range, 0, { kind: 'pairwise' })).toEqual({
    baseline: 'c2',
    current: 'c3',
  })
  expect(stripEnds(range, 3, { kind: 'pairwise' })).toBeUndefined()
  const root = { ...range, commits: [commit('r', null)] }
  expect(stripEnds(root, 0, { kind: 'pairwise' })).toBeUndefined()
})

it('keeps a locked baseline while Current steps', () => {
  const locked = { kind: 'locked', baseline: 'b' } as const
  expect(stripEnds(range, 2, locked)).toEqual({ baseline: 'b', current: 'c1' })
  expect(stripEnds(range, 0, locked)).toEqual({ baseline: 'b', current: 'c3' })
})

it('locks the chosen Baseline, or the strip base when none is chosen', () => {
  expect(lockedBaseline({ baseline: 'v1' }, range)).toBe('v1')
  expect(lockedBaseline({}, range)).toBe('b')
})

it('finds where Current sits on the strip and steps newer or older within it', () => {
  expect(stripPosition(range, 'c2')).toBe(1)
  expect(stripPosition(range, 'working-tree')).toBe(-1)
  expect(stripStep(range, 1, 1)).toBe(0)
  expect(stripStep(range, 0, 1)).toBeUndefined()
  expect(stripStep(range, 2, -1)).toBeUndefined()
  expect(stripStep(range, -1, 1)).toBe(2)
  expect(stripStep(range, -1, -1)).toBe(0)
  expect(stripStep({ ...range, commits: [] }, -1, 1)).toBeUndefined()
})

it('steps over commits the filter hides', () => {
  const shown = (index: number) => index !== 1
  expect(stripStep(range, 2, 1, shown)).toBe(0)
  expect(stripStep(range, 0, -1, shown)).toBe(2)
  expect(stripStep(range, -1, 1, shown)).toBe(2)
  expect(stripStep(range, -1, -1, () => false)).toBeUndefined()
})

it('reads blank fields as the default ends and reports refused refs', () => {
  expect(endsFromText(' ', '')).toEqual({ ends: {}, problems: {} })
  expect(endsFromText(' HEAD~2 ', 'v1')).toEqual({
    ends: { baseline: 'HEAD~2', current: 'v1' },
    problems: {},
  })
  const { problems } = endsFromText('-x', 'a b')
  expect(problems.baseline).toMatch(/"-"/)
  expect(problems.current).toMatch(/spaces/)
})

it('describes the shown History commit and its parent when History has loaded it', () => {
  const summary = (hash: string, parents: readonly string[], subject: string) => ({
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    refs: [],
    author: 'Ada',
    authoredAt: '2026-09-26T10:00:00+00:00',
    subject,
  })
  const loaded = [
    summary('c3', ['c2'], 'third'),
    summary('c2', ['c1'], 'second'),
    summary('c1', ['b'], 'first'),
  ]
  expect(describeShownCommit(loaded[1]!, loaded)).toEqual({
    c2: { subject: 'second', authoredAt: '2026-09-26T10:00:00+00:00' },
    c1: { subject: 'first', authoredAt: '2026-09-26T10:00:00+00:00' },
  })
  expect(describeShownCommit(loaded[2]!, loaded)).toEqual({
    c1: { subject: 'first', authoredAt: '2026-09-26T10:00:00+00:00' },
  })
})

it('describes the strip commits an end names', () => {
  expect(describeCommits(range, { baseline: 'c1', current: 'c2' })).toEqual({
    c1: { subject: 'subject c1', authoredAt: '2026-09-26T10:00:00+00:00' },
    c2: { subject: 'subject c2', authoredAt: '2026-09-26T10:00:00+00:00' },
  })
  expect(describeCommits(range, { baseline: 'b', current: 'c1' })).toEqual({
    b: { subject: 'subject b', authoredAt: '2026-09-26T10:00:00+00:00' },
    c1: { subject: 'subject c1', authoredAt: '2026-09-26T10:00:00+00:00' },
  })
  expect(describeCommits(range, { baseline: 'main', current: 'c1' })).toEqual({
    c1: { subject: 'subject c1', authoredAt: '2026-09-26T10:00:00+00:00' },
  })
})

const loaded: GitCommitSummary[] = ['4', '3', '2', '1'].map((digit) => ({
  hash: digit.repeat(40),
  shortHash: digit.repeat(7),
  parents: digit === '1' ? [] : [String(Number(digit) - 1).repeat(40)],
  refs: [],
  author: 'Ada',
  authoredAt: `2026-09-2${digit}T10:00:00+00:00`,
  subject: `commit ${digit}`,
}))
const h = (digit: string) => digit.repeat(40)

it('selects the inclusive range between two shown commits, oldest last, in either click order', () => {
  const forward = historyRange(h('2'), h('4'), loaded)
  expect(forward?.olderCommit.hash).toBe(h('2'))
  expect(forward?.newerCommit.hash).toBe(h('4'))
  expect(forward?.hashes).toEqual([h('4'), h('3'), h('2')])
  expect(historyRange(h('4'), h('2'), loaded)).toEqual(forward)
  expect(historyRange(h('2'), h('2'), loaded)).toBeUndefined()
  expect(historyRange(h('2'), h('9'), loaded)).toBeUndefined()
  expect(historyRange(h('2'), h('4'), loaded.slice(0, 2))).toBeUndefined()
})

it('spans hidden commits when the shown list is filtered', () => {
  const range = historyRange(h('4'), h('2'), [loaded[0]!, loaded[2]!])
  expect(range?.hashes).toEqual([h('4'), h('2')])
  expect(historyRangeEnds(range!)).toEqual({ baseline: h('1'), current: h('4') })
})

it('locks the range baseline to the state before the older commit and refuses a root', () => {
  expect(historyRangeEnds(historyRange(h('3'), h('4'), loaded)!)).toEqual({
    baseline: h('2'),
    current: h('4'),
  })
  expect(historyRangeEnds(historyRange(h('1'), h('4'), loaded)!)).toBeUndefined()
})

it('describes both ends of a range from the loaded commits', () => {
  const described = describeHistoryRange(historyRange(h('2'), h('4'), loaded)!, loaded)
  expect(described[h('1')]?.subject).toBe('commit 1')
  expect(described[h('4')]?.subject).toBe('commit 4')
})
