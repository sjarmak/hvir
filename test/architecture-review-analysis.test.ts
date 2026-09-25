import { describe, expect, it } from 'vitest'
import {
  analyzeArchitecture,
  scanArchitecture,
} from '../src/main/architecture-review/analysis'
import { parseArchitectureLayout } from '../src/shared/architecture-layout'

const input = (files: Record<string, string>) => ({
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
  scope: 'src/',
  exclusions: ['tests and declarations'],
})

describe('architecture review analysis', () => {
  it('extracts AST imports, type/runtime facts, source subsystems and unresolved imports', () => {
    const result = scanArchitecture(
      input({
        'src/a.ts':
          "import type { B } from './b'; export type { B } from './b'; export { b } from './b'; import('./b'); import './missing'; import 'node:fs'",
        'src/b.ts': 'export interface B {}\nexport const b = 1',
      }),
    )
    expect(
      result.modules.map((module) => [module.path, module.system, module.subsystem]),
    ).toEqual([
      ['src/a.ts', '(project)', 'src'],
      ['src/b.ts', '(project)', 'src'],
    ])
    expect(result.imports.map((fact) => [fact.form, fact.kind, fact.resolution])).toEqual(
      [
        ['import', 'type-only', 'internal'],
        ['export', 'type-only', 'internal'],
        ['export', 'runtime', 'internal'],
        ['dynamic-import', 'runtime', 'internal'],
        ['import', 'runtime', 'unresolved'],
        ['import', 'runtime', 'external'],
      ],
    )
    expect(result.imports.every((fact) => fact.line >= 1 && fact.column >= 1)).toBe(true)
    expect(result.diagnostics).toEqual([expect.objectContaining({ file: '(capture)' })])
  })

  it('keeps code-only edits separate from relationship changes', () => {
    const before = input({
      'src/a.ts': "import './b'; export const a = 1",
      'src/b.ts': 'export const b = 1',
    })
    const after = input({
      'src/a.ts': "import './b'; export const a = 2",
      'src/b.ts': 'export const b = 1',
    })
    const result = analyzeArchitecture(before, after)
    expect(result.modules.map((module) => [module.path, module.change])).toEqual([
      ['src/a.ts', 'changed'],
      ['src/b.ts', 'unchanged'],
    ])
    expect(result.imports.every((fact) => fact.change === 'unchanged')).toBe(true)
    expect(result.imports[0]?.beforeLine).toBeUndefined()
    expect(result.relationships).toEqual([])
  })

  it('retains baseline locations and duplicate import evidence', () => {
    const result = analyzeArchitecture(
      input({ 'src/a.ts': "import './b';\nimport './b'", 'src/b.ts': '' }),
      input({ 'src/a.ts': "\nimport './b';\nimport './b'", 'src/b.ts': '' }),
    )
    expect(result.imports).toHaveLength(2)
    expect(result.imports.map((fact) => [fact.line, fact.beforeLine])).toEqual([
      [2, 1],
      [3, 2],
    ])
  })

  it('marks replacement imports as a changed existing relationship', () => {
    const result = analyzeArchitecture(
      input({ 'src/a.ts': "import './old'", 'src/old.ts': '' }),
      input({ 'src/a.ts': "import './new'", 'src/new.ts': '' }),
    )
    expect(result.relationships).toEqual([])
    expect(result.imports.filter((fact) => fact.change === 'added')).toHaveLength(1)
    expect(result.imports.filter((fact) => fact.change === 'removed')).toHaveLength(1)
  })

  it('keeps removed relationship targets in the baseline grouping', () => {
    const result = analyzeArchitecture(
      input({ 'src/owner/a.ts': "import '../old/b.ts'", 'src/old/b.ts': '' }),
      input({ 'src/owner/a.ts': '' }),
    )
    expect(result.relationships).toEqual([
      expect.objectContaining({
        source: 'src/owner',
        target: 'src/old',
        change: 'removed',
      }),
    ])
  })

  it('names subsystems and relationships by the layout the scan was given', () => {
    const layout = parseArchitectureLayout(
      JSON.stringify({
        version: 1,
        subsystems: [{ name: 'shell', paths: ['src/ui', 'src/app.ts'] }],
      }),
    )
    const files = {
      'src/app.ts': "import './ui/view'; import './data/store'",
      'src/ui/view.ts': "import '../data/store'",
      'src/data/store.ts': '',
    }
    const result = analyzeArchitecture(input({}), { ...input(files), layout })
    expect(result.modules.map((module) => [module.path, module.subsystem])).toEqual([
      ['src/app.ts', 'shell'],
      ['src/data/store.ts', 'src/data'],
      ['src/ui/view.ts', 'shell'],
    ])
    expect(
      result.relationships.map((r) => [r.source, r.target, r.before, r.after]),
    ).toEqual([['shell', 'src/data', 0, 2]])
  })

  it('assigns explicit systems before inferred systems', () => {
    const layout = parseArchitectureLayout(
      JSON.stringify({
        version: 1,
        systems: [{ name: 'desktop', paths: ['src'] }],
      }),
    )
    const result = scanArchitecture({
      ...input({ 'src/main/index.ts': '' }),
      configs: [{ path: 'package.json', content: '{"dependencies":{"electron":"1"}}' }],
      layout,
    })
    expect(result.modules[0]?.system).toBe('desktop')
  })

  it('fingerprints the layout with the files it groups', () => {
    const files = input({ 'src/a.ts': '' })
    const layout = parseArchitectureLayout(
      JSON.stringify({ version: 1, sourceRoots: ['lib'] }),
    )
    expect(scanArchitecture({ ...files, layout }).fingerprint).not.toBe(
      scanArchitecture(files).fingerprint,
    )
  })

  it('uses captured compiler options when aliases are available', () => {
    const result = scanArchitecture({
      ...input({
        'src/a.ts': "import { B } from '@app/b'",
        'src/b.ts': 'export type B = string',
      }),
      configs: [
        {
          path: 'tsconfig.json',
          content: JSON.stringify({
            compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
          }),
        },
      ],
    })
    expect(result.imports[0]).toEqual(
      expect.objectContaining({ resolution: 'internal', target: 'src/b.ts' }),
    )
    expect(result.diagnostics).toEqual([])
  })

  it('includes deleted modules and imports in the pinned before/after result', () => {
    const result = analyzeArchitecture(
      input({ 'src/a.ts': "import './gone'" }),
      input({ 'src/a.ts': '' }),
    )
    expect(result.modules.find((module) => module.path === 'src/a.ts')?.change).toBe(
      'changed',
    )
    expect(result.imports).toEqual([
      expect.objectContaining({ change: 'removed', specifier: './gone' }),
    ])
    expect(result.after.fingerprint).not.toBe(result.before.fingerprint)
  })
})
