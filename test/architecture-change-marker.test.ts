import { expect, it } from 'vitest'
import { changeMarker } from '../src/renderer/src/architecture-review/change-marker'

const feature = { type: 'Feature', architectural: 'architectural', beads: [] }

it('labels a classified merge by its change type and a bare merge as Merge', () => {
  expect(changeMarker(true, 'architecture', feature)).toEqual({
    kind: 'merge',
    label: 'Feature',
    title: 'Feature · Architectural',
  })
  expect(changeMarker(true, undefined, undefined)).toEqual({
    kind: 'merge',
    label: 'Merge',
  })
  expect(changeMarker(true, 'code', undefined)).toEqual({ kind: 'merge', label: 'Merge' })
})

it('labels a classified row by its change type and a heuristic row by its marker', () => {
  expect(changeMarker(false, 'none', { type: 'Documentation', beads: [] })).toEqual({
    kind: 'none',
    label: 'Documentation',
    title: 'Documentation',
  })
  expect(changeMarker(false, 'architecture', undefined)).toEqual({
    kind: 'architecture',
    label: 'Architecture',
  })
  expect(changeMarker(false, 'unclassified', undefined)).toEqual({
    kind: 'unclassified',
    label: 'Unclassified',
  })
  expect(changeMarker(false, 'none', undefined)).toBeUndefined()
  expect(changeMarker(false, undefined, undefined)).toBeUndefined()
})
