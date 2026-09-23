import { expect, it } from 'vitest'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'
import { subsystemMap } from '../src/renderer/src/architecture-review/architecture-review-model'
const before = {
  files: [
    { path: 'src/ui/a.ts', content: 'import {a} from "../data/a"' },
    { path: 'src/data/a.ts', content: 'export const a=1' },
    { path: 'src/other/x.ts', content: 'const x=1' },
  ],
  scope: '.',
  exclusions: [],
}
const after = {
  ...before,
  files: [
    { path: 'src/ui/a.ts', content: 'import {b} from "../data/b"' },
    { path: 'src/data/a.ts', content: 'export const a=1' },
    { path: 'src/data/b.ts', content: 'export const b=1' },
    { path: 'src/other/x.ts', content: 'const x=1' },
  ],
}
it('keeps replaced imports on the existing subsystem relationship and supplies exact source evidence', () => {
  const map = subsystemMap(analyzeArchitecture(before, after), false)
  expect(map.nodes.map((n) => n.id)).toEqual(['src/data', 'src/ui'])
  expect(map.relationships).toHaveLength(1)
  expect(map.relationships[0]).toMatchObject({
    source: 'src/ui',
    target: 'src/data',
    change: 'changed',
  })
  expect(map.relationships[0]?.evidence.map((e) => e.source)).toEqual([
    'src/ui/a.ts',
    'src/ui/a.ts',
  ])
})
it('does not invent dependencies for a code-only edit, and retains explicit all-files exploration', () => {
  const result = analyzeArchitecture(before, {
    ...before,
    files: before.files.map((f) =>
      f.path === 'src/other/x.ts' ? { ...f, content: 'const x=2' } : f,
    ),
  })
  expect(subsystemMap(result, false).nodes.map((n) => n.id)).toEqual(['src/other'])
  expect(subsystemMap(result, false).relationships).toHaveLength(0)
  expect(subsystemMap(result, true).nodes.map((n) => n.id)).toContain('src/ui')
})
