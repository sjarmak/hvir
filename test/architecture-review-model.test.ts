import { expect, it } from 'vitest'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'
import { ARCHITECTURE_DEFAULT_LAYOUT } from '../src/shared/architecture-layout'
import {
  evidenceByModule,
  layoutSummary,
  subsystemMap,
} from '../src/renderer/src/architecture-review/architecture-review-model'

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

it('drills a relationship into its modules, each with its own import evidence', () => {
  const before = { files: [], scope: '.', exclusions: [] }
  const analysis = analyzeArchitecture(before, {
    ...before,
    files: [
      { path: 'ui/b.ts', content: 'import "../data/a"' },
      { path: 'ui/a.ts', content: 'import "../data/a"\nimport "../data/c"' },
      { path: 'data/a.ts', content: '' },
      { path: 'data/c.ts', content: '' },
    ],
  })
  const [relationship] = analysis.relationships
  const drilled = evidenceByModule(relationship!.evidence, 2)
  expect(
    drilled.modules.map((entry) => [entry.module, entry.imports.map((e) => e.line)]),
  ).toEqual([['ui/a.ts', [1, 2]]])
  expect(drilled.omitted).toBe(1)
  expect(
    evidenceByModule(relationship!.evidence, 100).modules.map((entry) => entry.module),
  ).toEqual(['ui/a.ts', 'ui/b.ts'])
})

it('summarises where subsystems and scope came from', () => {
  expect(layoutSummary(ARCHITECTURE_DEFAULT_LAYOUT)).toEqual({
    subsystems: 'First directory under src (no .hvir/architecture.json)',
    scope: 'Whole repository',
  })
  expect(
    layoutSummary({
      origin: 'override',
      scope: ['lib'],
      sourceRoots: ['lib', 'app'],
      subsystems: [
        { name: 'a', paths: ['lib/a'] },
        { name: 'b', paths: ['lib/b'] },
      ],
    }),
  ).toEqual({
    subsystems:
      '.hvir/architecture.json: 2 rules, then the first directory under lib, app',
    scope: 'lib',
  })
})
