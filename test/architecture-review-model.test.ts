import { expect, it } from 'vitest'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'
import { subsystemMap } from '../src/renderer/src/architecture-review/architecture-review-model'

it('keeps unchanged adjacent subsystems as context without unchanged external imports', () => {
  const files = [
    { path: 'ui/a.ts', content: 'import "../data/a"; import "react"' },
    { path: 'data/a.ts', content: 'export const a=1' },
    { path: 'other/a.ts', content: 'export const a=1' },
  ]
  const before = { files, scope: '.', exclusions: [] }
  const analysis = analyzeArchitecture(before, {
    ...before,
    files: files.map((f) =>
      f.path === 'ui/a.ts' ? { ...f, content: f.content + '; const x=1' } : f,
    ),
  })
  const map = subsystemMap(analysis, false)
  expect(map.nodes.map((n) => n.id)).toEqual(['ui', 'data'])
  expect(map.nodes.find((n) => n.id === 'data')?.nearby).toBe(true)
  expect(map.relationships.map((r) => r.target)).toEqual(['data'])
})

it('bounds a large graph and discloses omitted subsystems', () => {
  const files = Array.from({ length: 50 }, (_, i) => ({
    path: `group${i}/a.ts`,
    content: 'export const a=1',
  }))
  const analysis = analyzeArchitecture(
    { files: [], scope: '.', exclusions: [] },
    { files, scope: '.', exclusions: [] },
  )
  const map = subsystemMap(analysis, false)
  expect(map.nodes).toHaveLength(40)
  expect(map.omittedNodes).toBe(10)
  expect(analysis.modules).toHaveLength(50)
})
