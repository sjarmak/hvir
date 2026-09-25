import { expect, it } from 'vitest'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'
import {
  architectureCanvasElements,
  subsystemMap,
} from '../src/renderer/src/architecture-review/architecture-review-model'
import { layoutArchitectureGraph } from '../src/renderer/src/architecture-review/architecture-layout'
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

it('keeps the same union layout across comparison views and equivalent snapshots', async () => {
  const first = subsystemMap(analyzeArchitecture(before, after), false)
  const second = subsystemMap(analyzeArchitecture(after, before), false)
  const beforeElements = architectureCanvasElements(first, 'before')
  const afterElements = architectureCanvasElements(first, 'after')
  const nextElements = architectureCanvasElements(second, 'overlay')

  expect(beforeElements.layout).toEqual(afterElements.layout)
  expect(nextElements.layout).toEqual(beforeElements.layout)

  const [beforeLayout, afterLayout, nextLayout] = await Promise.all([
    layoutArchitectureGraph(beforeElements.layout),
    layoutArchitectureGraph(afterElements.layout),
    layoutArchitectureGraph(nextElements.layout),
  ])
  expect(afterLayout).toEqual(beforeLayout)
  expect(nextLayout).toEqual(beforeLayout)
})

it('keeps a common subsystem fixed when different modules change in the same union', async () => {
  const files = [
    { path: 'src/a/index.ts', content: 'import "../b"\nexport const a = 1' },
    { path: 'src/b/index.ts', content: 'export const b = 1' },
    { path: 'src/c/index.ts', content: 'import "../b"\nexport const c = 1' },
  ]
  const capture = (next: typeof files) => ({ scope: '.', exclusions: [], files: next })
  const changed = (segment: string) =>
    files.map((file) =>
      file.path.includes(segment)
        ? { ...file, content: `${file.content}\nexport const changed = 1` }
        : file,
    )
  const first = subsystemMap(
    analyzeArchitecture(capture(files), capture(changed('/a/'))),
    false,
  )
  const second = subsystemMap(
    analyzeArchitecture(capture(files), capture(changed('/b/'))),
    false,
  )
  const [firstLayout, secondLayout] = await Promise.all([
    layoutArchitectureGraph(architectureCanvasElements(first, 'overlay').layout),
    layoutArchitectureGraph(architectureCanvasElements(second, 'overlay').layout),
  ])

  expect(first.nodes.map((node) => node.id)).toEqual(['src/a', 'src/b'])
  expect(second.nodes.map((node) => node.id)).toEqual(['src/b', 'src/a', 'src/c'])
  expect(secondLayout.find((node) => node.id === 'src/b')).toEqual(
    firstLayout.find((node) => node.id === 'src/b'),
  )
})

it('keeps layout stable when the expanded subsystem becomes hidden', async () => {
  const files = [
    { path: 'src/a/index.ts', content: 'import "../b"\nexport const a = 1' },
    { path: 'src/b/index.ts', content: 'export const b = 1' },
    { path: 'src/c/index.ts', content: 'import "../b"\nexport const c = 1' },
    { path: 'src/d/index.ts', content: 'export const d = 1' },
    { path: 'src/d/two.ts', content: 'export const d2 = 1' },
  ]
  const capture = (next: typeof files) => ({ scope: '.', exclusions: [], files: next })
  const changed = (segment: string) =>
    files.map((file) =>
      file.path.includes(segment)
        ? { ...file, content: `${file.content}\nexport const changed = 1` }
        : file,
    )
  const visible = subsystemMap(
    analyzeArchitecture(capture(files), capture(changed('/d/'))),
    false,
  )
  const hidden = subsystemMap(
    analyzeArchitecture(capture(files), capture(changed('/b/'))),
    false,
  )
  const [visibleLayout, hiddenLayout] = await Promise.all([
    layoutArchitectureGraph(
      architectureCanvasElements(visible, 'overlay', 'src/d').layout,
    ),
    layoutArchitectureGraph(
      architectureCanvasElements(hidden, 'overlay', 'src/d').layout,
    ),
  ])

  expect(visible.nodes.map((node) => node.id)).toContain('src/d')
  expect(hidden.nodes.map((node) => node.id)).not.toContain('src/d')
  expect(hiddenLayout).toEqual(visibleLayout)
})

it('projects change styling and expands subsystem modules into the canvas', () => {
  const map = subsystemMap(analyzeArchitecture(before, after), false)
  const collapsed = architectureCanvasElements(map, 'after')
  const expanded = architectureCanvasElements(map, 'after', 'src/data')

  expect(collapsed.nodes.find((node) => node.id === 'src/data')).toMatchObject({
    change: 'changed',
    ghost: false,
  })
  expect(collapsed.edges).toEqual([
    expect.objectContaining({ change: 'changed', ghost: false }),
  ])
  expect(expanded.nodes.map((node) => node.id)).toContain('module:src/data/a.ts')
  expect(expanded.nodes.map((node) => node.id)).toContain('module:src/data/b.ts')
  expect(expanded.nodes.find((node) => node.id === 'module:src/data/a.ts')).toMatchObject(
    {
      change: 'unchanged',
      ghost: false,
    },
  )
  expect(
    architectureCanvasElements(map, 'before', 'src/data').nodes.find(
      (node) => node.id === 'module:src/data/b.ts',
    ),
  ).toMatchObject({ change: 'added', ghost: true })
  expect(expanded.layout.nodes.map((node) => node.id)).toEqual(
    expect.arrayContaining(['src/data', 'module:src/data/a.ts', 'module:src/data/b.ts']),
  )
})
