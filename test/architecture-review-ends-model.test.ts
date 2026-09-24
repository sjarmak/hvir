import { expect, it } from 'vitest'
import {
  endsFromText,
  lockedBaseline,
  stripEnds,
  stripPosition,
  stripStep,
} from '../src/renderer/src/architecture-review/architecture-ends-model'
import type { ArchitectureCommitRange } from '../src/shared/architecture-review'

const commit = (revision: string, parent: string | null) => ({
  revision,
  parent,
  subject: `subject ${revision}`,
})
const range: ArchitectureCommitRange = {
  base: commit('b', 'z'),
  commits: [commit('c1', 'b'), commit('c2', 'c1'), commit('c3', 'c2')],
  truncated: false,
}

it('steps pairwise from each commit to its first parent by default', () => {
  expect(stripEnds(range, 0, { kind: 'pairwise' })).toEqual({
    baseline: 'b',
    current: 'c1',
  })
  expect(stripEnds(range, 2, { kind: 'pairwise' })).toEqual({
    baseline: 'c2',
    current: 'c3',
  })
  expect(stripEnds(range, 3, { kind: 'pairwise' })).toBeUndefined()
  const root = { ...range, commits: [commit('r', null)] }
  expect(stripEnds(root, 0, { kind: 'pairwise' })).toBeUndefined()
})

it('keeps a locked baseline while Current steps', () => {
  const locked = { kind: 'locked', baseline: 'b' } as const
  expect(stripEnds(range, 0, locked)).toEqual({ baseline: 'b', current: 'c1' })
  expect(stripEnds(range, 2, locked)).toEqual({ baseline: 'b', current: 'c3' })
})

it('locks the chosen Baseline, or the strip base when none is chosen', () => {
  expect(lockedBaseline({ baseline: 'v1' }, range)).toBe('v1')
  expect(lockedBaseline({}, range)).toBe('b')
})

it('finds where Current sits on the strip and steps within it', () => {
  expect(stripPosition(range, 'c2')).toBe(1)
  expect(stripPosition(range, 'working-tree')).toBe(-1)
  expect(stripStep(range, 1, 1)).toBe(2)
  expect(stripStep(range, 2, 1)).toBeUndefined()
  expect(stripStep(range, 0, -1)).toBeUndefined()
  expect(stripStep(range, -1, 1)).toBe(0)
  expect(stripStep(range, -1, -1)).toBe(2)
  expect(stripStep({ ...range, commits: [] }, -1, 1)).toBeUndefined()
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
