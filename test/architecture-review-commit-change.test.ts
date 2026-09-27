import { describe, expect, it } from 'vitest'
import {
  changeFromAnalysis,
  classifyCommitChange,
  configChanged,
  parseCommitDiffs,
  type CommitDiffEntry,
  type ImportSignature,
} from '../src/main/architecture-review/commit-change'
import { ARCHITECTURE_DEFAULT_LAYOUT } from '../src/shared/architecture-layout'
import type {
  ArchitectureAnalysis,
  ArchitectureModule,
  ArchitectureScanResult,
} from '../src/shared/architecture-analysis'

const NONE = '0'.repeat(40)
const blob = (name: string) => Buffer.from(name).toString('hex').padEnd(40, '0')
const entry = (
  path: string,
  status: string,
  before = blob('b'),
  after = blob('a'),
): CommitDiffEntry => ({ path, status, before, after })
const runtime = (specifier: string): ImportSignature => ({
  specifier,
  form: 'import',
  typeOnly: false,
})
const imports = (
  pairs: readonly (readonly [string, readonly ImportSignature[] | null])[],
) => new Map(pairs)
const layout = ARCHITECTURE_DEFAULT_LAYOUT

describe('parseCommitDiffs', () => {
  it('reads each commit, its parents and its raw entries against the first parent', () => {
    const output = [
      `\x1e${blob('c1')}\x1f${blob('p1')} ${blob('p2')}\0\n`,
      `:100644 100644 ${blob('x')} ${blob('y')} M\0src/a.ts\0`,
      `:000000 100644 ${NONE} ${blob('z')} A\0src/b.ts\0`,
      `\x1e${blob('c2')}\x1f\0\n`,
      `\x1e${blob('c3')}\x1f${blob('c2')}\0`,
    ].join('')
    expect(parseCommitDiffs(output)).toEqual([
      {
        revision: blob('c1'),
        parents: [blob('p1'), blob('p2')],
        entries: [
          entry('src/a.ts', 'M', blob('x'), blob('y')),
          entry('src/b.ts', 'A', NONE, blob('z')),
        ],
      },
      { revision: blob('c2'), parents: [], entries: [] },
      { revision: blob('c3'), parents: [blob('c2')], entries: [] },
    ])
  })
  it('refuses malformed records', () => {
    expect(() => parseCommitDiffs('\x1enot-a-hash\x1f\0')).toThrow(/Malformed/)
    expect(() => parseCommitDiffs(`\x1e${blob('c')}\x1f\0\n:100644 bad\0p\0`)).toThrow(
      /Malformed/,
    )
  })
})

describe('classifyCommitChange', () => {
  it('is none when nothing in scope changed', () => {
    expect(classifyCommitChange([], layout, imports([]))).toBe('none')
    expect(
      classifyCommitChange(
        [
          entry('README.md', 'M'),
          entry('docs/x.ts', 'M'),
          entry('node_modules/a/i.ts', 'A'),
        ],
        { ...layout, scope: ['src'] },
        imports([]),
      ),
    ).toBe('none')
  })
  it('is architecture when a module is added or removed', () => {
    expect(
      classifyCommitChange([entry('src/a.ts', 'A', NONE)], layout, imports([])),
    ).toBe('architecture')
    expect(
      classifyCommitChange(
        [entry('src/a.ts', 'D', blob('b'), NONE)],
        layout,
        imports([]),
      ),
    ).toBe('architecture')
  })
  it('lets the scan decide a layout or config change, and is unclassified without one', () => {
    const configs = [entry('.hvir/architecture.json', 'M'), entry('tsconfig.json', 'M')]
    for (const config of configs) {
      expect(configChanged([config], layout)).toBe(true)
      expect(classifyCommitChange([config], layout, imports([]))).toBe('unclassified')
      expect(classifyCommitChange([config], layout, imports([]), 'none')).toBe('none')
      expect(classifyCommitChange([config], layout, imports([]), 'architecture')).toBe(
        'architecture',
      )
    }
    expect(configChanged([entry('src/a.ts', 'M')], layout)).toBe(false)
    expect(
      classifyCommitChange(
        [entry('tsconfig.json', 'M'), entry('src/a.ts', 'A', NONE)],
        layout,
        imports([]),
      ),
    ).toBe('architecture')
  })
  it('is architecture when a modified module imports differently, else code', () => {
    const same = imports([
      [blob('b'), [runtime('./x')]],
      [blob('a'), [runtime('./x')]],
    ])
    expect(classifyCommitChange([entry('src/a.ts', 'M')], layout, same)).toBe('code')
    const rewired = imports([
      [blob('b'), [runtime('./x')]],
      [blob('a'), [runtime('./y')]],
    ])
    expect(classifyCommitChange([entry('src/a.ts', 'M')], layout, rewired)).toBe(
      'architecture',
    )
    const reordered = imports([
      [blob('b'), [runtime('./x'), runtime('./y')]],
      [blob('a'), [runtime('./y'), runtime('./x')]],
    ])
    expect(classifyCommitChange([entry('src/a.ts', 'M')], layout, reordered)).toBe('code')
    const typeFlip = imports([
      [blob('b'), [runtime('./x')]],
      [blob('a'), [{ ...runtime('./x'), typeOnly: true }]],
    ])
    expect(classifyCommitChange([entry('src/a.ts', 'M')], layout, typeFlip)).toBe(
      'architecture',
    )
  })
  it('treats a file no scanner reads as code, and a file it could not read as unclassified', () => {
    expect(
      classifyCommitChange(
        [entry('src/a.ts', 'M')],
        layout,
        imports([
          [blob('b'), null],
          [blob('a'), null],
        ]),
      ),
    ).toBe('code')
    expect(classifyCommitChange([entry('src/a.ts', 'M')], layout, imports([]))).toBe(
      'unclassified',
    )
  })
  it('ignores a source outside the layout scope but never a config outside it', () => {
    const scoped = { ...layout, scope: ['src/app'] }
    expect(
      classifyCommitChange([entry('src/lib/a.ts', 'A', NONE)], scoped, imports([])),
    ).toBe('none')
    expect(classifyCommitChange([entry('package.json', 'M')], scoped, imports([]))).toBe(
      'unclassified',
    )
  })
})

describe('changeFromAnalysis', () => {
  const module = (path: string, subsystem: string, hash = 'h'): ArchitectureModule => ({
    path,
    system: 'app',
    subsystem,
    hash,
    symbols: [],
  })
  const side = (modules: readonly ArchitectureModule[]): ArchitectureScanResult => ({
    fingerprint: 'f',
    scope: 'src',
    exclusions: [],
    modules,
    imports: [],
    diagnostics: [],
  })
  const analysis = (
    before: readonly ArchitectureModule[],
    after: readonly ArchitectureModule[],
    rest: Partial<ArchitectureAnalysis> = {},
  ): ArchitectureAnalysis => ({
    before: side(before),
    after: side(after),
    modules: [],
    imports: [],
    relationships: [],
    ...rest,
  })
  const importFact = {
    source: 'src/a.ts',
    specifier: './b',
    form: 'import' as const,
    kind: 'runtime' as const,
    resolution: 'internal' as const,
    line: 1,
    column: 1,
  }
  it('is none or code when the scan shows the same modules, mapping and imports', () => {
    const same = analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'a', 'h2')])
    expect(changeFromAnalysis(same, 0)).toBe('none')
    expect(changeFromAnalysis(same, 1)).toBe('code')
    const moved = analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'a')], {
      imports: [{ ...importFact, change: 'unchanged', beforeLine: 3, beforeColumn: 1 }],
    })
    expect(changeFromAnalysis(moved, 1)).toBe('code')
  })
  it('is architecture when a module, its subsystem or an import changed', () => {
    expect(
      changeFromAnalysis(
        analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'b')]),
        0,
      ),
    ).toBe('architecture')
    expect(changeFromAnalysis(analysis([], [module('src/a.ts', 'a')]), 0)).toBe(
      'architecture',
    )
    expect(
      changeFromAnalysis(
        analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'a')], {
          imports: [{ ...importFact, change: 'added' }],
        }),
        0,
      ),
    ).toBe('architecture')
  })
})

describe('classifyCommitChange properties', () => {
  const random = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const pick = <T>(next: () => number, items: readonly T[]): T =>
    items[Math.floor(next() * items.length)]!
  const paths = [
    'src/a.ts',
    'src/b.tsx',
    'src/c.py',
    'lib/d.go',
    'README.md',
    'docs/e.ts',
    'package.json',
    '.hvir/architecture.json',
    'dist/f.ts',
  ]
  const statuses = ['A', 'D', 'M', 'T']
  const signatures: readonly (readonly ImportSignature[] | null)[] = [
    [],
    [runtime('./x')],
    [runtime('./y')],
    [runtime('./x'), runtime('./y')],
    null,
  ]
  const generate = (seed: number) => {
    const next = random(seed)
    const count = Math.floor(next() * 5)
    const entries: CommitDiffEntry[] = []
    const table = new Map<string, readonly ImportSignature[] | null>()
    for (let index = 0; index < count; index += 1) {
      const status = pick(next, statuses)
      const before = status === 'A' ? NONE : blob(`b${seed}-${index}`)
      const after = status === 'D' ? NONE : blob(`a${seed}-${index}`)
      entries.push({ path: pick(next, paths), status, before, after })
      if (next() < 0.85) table.set(before, pick(next, signatures))
      if (next() < 0.85) table.set(after, pick(next, signatures))
    }
    return { entries, table }
  }
  const touchesSource = (entries: readonly CommitDiffEntry[]) =>
    entries.some((e) => /\.(ts|tsx|py|go)$/.test(e.path) && !e.path.startsWith('dist/'))
  const touchesScope = (entries: readonly CommitDiffEntry[]) =>
    touchesSource(entries) ||
    entries.some((e) => e.path === 'package.json' || e.path === '.hvir/architecture.json')

  it('never reports architecture without an in-scope change and never none with one', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const { entries, table } = generate(seed)
      const change = classifyCommitChange(entries, layout, table)
      if (!touchesScope(entries)) expect(change).toBe('none')
      else expect(change).not.toBe('none')
    }
  })
  it('does not depend on entry order', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const { entries, table } = generate(seed)
      const reversed = [...entries].reverse()
      expect(classifyCommitChange(reversed, layout, table)).toBe(
        classifyCommitChange(entries, layout, table),
      )
    }
  })
  it('is code only when every in-scope change is a modification with equal imports', () => {
    let codeCases = 0
    for (let seed = 1; seed <= 400; seed += 1) {
      const { entries, table } = generate(seed)
      if (classifyCommitChange(entries, layout, table) !== 'code') continue
      codeCases += 1
      for (const e of entries.filter((candidate) => touchesScope([candidate]))) {
        expect(['M', 'T']).toContain(e.status)
        expect(table.get(e.before)).toBeDefined()
        expect(table.get(e.after)).toBeDefined()
      }
    }
    expect(codeCases).toBeGreaterThan(0)
  })
})
