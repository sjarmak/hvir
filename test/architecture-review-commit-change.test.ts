import { describe, expect, it } from 'vitest'
import {
  changeFromAnalysis,
  classifyCommitChange,
  configChanged,
  parseCommitDiffs,
  edgeKey,
  type CommitDiff,
  type CommitDiffEntry,
  type EdgeTable,
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
const PARENT = blob('parent')
const COMMIT = blob('commit')
const diff = (entries: readonly CommitDiffEntry[]): CommitDiff => ({
  revision: COMMIT,
  parents: [PARENT],
  entries,
})
const edges = (
  before: readonly string[] | null,
  after: readonly string[] | null,
): EdgeTable =>
  new Map([
    [edgeKey(PARENT, 'src/a.ts', blob('b')), before],
    [edgeKey(COMMIT, 'src/a.ts', blob('a')), after],
  ])
const none: EdgeTable = new Map()
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
    expect(classifyCommitChange(diff([]), layout, none)).toBe('none')
    expect(
      classifyCommitChange(
        diff([entry('README.md', 'M'), entry('dist/out.js', 'A', NONE)]),
        layout,
        none,
      ),
    ).toBe('none')
  })
  it('is architecture when a module is added, deleted, renamed or moved', () => {
    expect(classifyCommitChange(diff([entry('src/a.ts', 'A', NONE)]), layout, none)).toBe(
      'architecture',
    )
    expect(
      classifyCommitChange(diff([entry('src/a.ts', 'D', blob('b'), NONE)]), layout, none),
    ).toBe('architecture')
  })
  it('needs a scan when a config changed without a structural change', () => {
    for (const config of [
      entry('package.json', 'M'),
      entry('tsconfig.json', 'M'),
      entry('.hvir/architecture.json', 'M'),
    ]) {
      expect(configChanged([config], layout)).toBe(true)
      expect(classifyCommitChange(diff([config]), layout, none)).toBe('unclassified')
      expect(classifyCommitChange(diff([config]), layout, none, 'none')).toBe('none')
      expect(classifyCommitChange(diff([config]), layout, none, 'architecture')).toBe(
        'architecture',
      )
    }
    expect(configChanged([entry('src/a.ts', 'M')], layout)).toBe(false)
    expect(
      classifyCommitChange(
        diff([entry('tsconfig.json', 'M'), entry('src/a.ts', 'A', NONE)]),
        layout,
        none,
      ),
    ).toBe('architecture')
  })
  it('is architecture when a modified module reaches a different set of targets, else code', () => {
    const modified = diff([entry('src/a.ts', 'M')])
    expect(
      classifyCommitChange(modified, layout, edges(['src/x.ts'], ['src/x.ts'])),
    ).toBe('code')
    expect(
      classifyCommitChange(modified, layout, edges(['src/x.ts'], ['src/y.ts'])),
    ).toBe('architecture')
    expect(
      classifyCommitChange(
        modified,
        layout,
        edges(['src/x.ts'], ['src/x.ts', 'external: node:fs']),
      ),
    ).toBe('architecture')
    expect(
      classifyCommitChange(
        modified,
        layout,
        edges(['src/x.ts', 'src/y.ts'], ['src/y.ts', 'src/x.ts']),
      ),
    ).toBe('code')
    expect(
      classifyCommitChange(
        modified,
        layout,
        edges(['src/x.ts', 'src/x.ts'], ['src/x.ts']),
      ),
    ).toBe('code')
  })
  it('is unclassified when any side of a modified module is missing', () => {
    const modified = diff([entry('src/a.ts', 'M')])
    expect(classifyCommitChange(modified, layout, none)).toBe('unclassified')
    expect(
      classifyCommitChange(
        modified,
        layout,
        new Map([[edgeKey(PARENT, 'src/a.ts', blob('b')), ['src/x.ts']]]),
      ),
    ).toBe('unclassified')
    expect(
      classifyCommitChange(
        modified,
        layout,
        new Map([[edgeKey(COMMIT, 'src/a.ts', blob('a')), ['src/x.ts']]]),
      ),
    ).toBe('unclassified')
    expect(
      classifyCommitChange(
        { ...modified, parents: [] },
        layout,
        edges(['src/x.ts'], ['src/x.ts']),
      ),
    ).toBe('unclassified')
  })
  it('keys edges by side and path so one blob resolves per tree and per importing module', () => {
    const modified = diff([entry('src/a.ts', 'M', blob('s'), blob('s'))])
    const table = new Map([
      [edgeKey(PARENT, 'src/a.ts', blob('s')), ['src/x.ts']],
      [edgeKey(COMMIT, 'src/a.ts', blob('s')), ['src/x/index.ts']],
    ])
    expect(classifyCommitChange(modified, layout, table)).toBe('architecture')
    const twins = diff([
      entry('src/a/main.ts', 'M', blob('s'), blob('t')),
      entry('src/z/main.ts', 'M', blob('s'), blob('t')),
    ])
    const perPath = new Map([
      [edgeKey(PARENT, 'src/a/main.ts', blob('s')), ['src/a/x.ts']],
      [edgeKey(COMMIT, 'src/a/main.ts', blob('t')), ['src/a/x/index.ts']],
      [edgeKey(PARENT, 'src/z/main.ts', blob('s')), ['src/z/x/index.ts']],
      [edgeKey(COMMIT, 'src/z/main.ts', blob('t')), ['src/z/x/index.ts']],
    ])
    expect(classifyCommitChange(twins, layout, perPath)).toBe('architecture')
    const blobOnly = new Map([
      [edgeKey(PARENT, 'src/z/main.ts', blob('s')), ['src/z/x/index.ts']],
      [edgeKey(COMMIT, 'src/z/main.ts', blob('t')), ['src/z/x/index.ts']],
    ])
    expect(classifyCommitChange(twins, layout, blobOnly)).toBe('unclassified')
  })
  it('treats a file no scanner reads as code', () => {
    expect(
      classifyCommitChange(diff([entry('src/a.ts', 'M')]), layout, edges(null, null)),
    ).toBe('code')
  })
  it('ignores a source outside the layout scope but never a config outside it', () => {
    const scoped = { ...layout, scope: ['src/app'] }
    expect(
      classifyCommitChange(diff([entry('src/lib/a.ts', 'A', NONE)]), scoped, none),
    ).toBe('none')
    expect(classifyCommitChange(diff([entry('package.json', 'M')]), scoped, none)).toBe(
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
    target: 'src/b.ts',
    specifier: './b',
    form: 'import' as const,
    kind: 'runtime' as const,
    resolution: 'internal' as const,
    line: 1,
    column: 1,
  }
  const external = {
    source: 'src/a.ts',
    specifier: 'x',
    form: 'import' as const,
    kind: 'runtime' as const,
    resolution: 'external' as const,
    line: 1,
    column: 1,
  }
  it('is none or code when the scan shows the same modules, mapping and edges', () => {
    const same = analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'a', 'h2')])
    expect(changeFromAnalysis(same, 0)).toBe('none')
    expect(changeFromAnalysis(same, 1)).toBe('code')
    const moved = analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'a')], {
      imports: [{ ...importFact, change: 'unchanged', beforeLine: 3, beforeColumn: 1 }],
    })
    expect(changeFromAnalysis(moved, 1)).toBe('code')
    const duplicated = analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'a')], {
      imports: [
        { ...importFact, change: 'unchanged' },
        { ...importFact, form: 'dynamic-import', line: 9, change: 'added' },
      ],
    })
    expect(changeFromAnalysis(duplicated, 1)).toBe('code')
    const typeFlip = analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'a')], {
      imports: [
        { ...importFact, change: 'removed' },
        { ...importFact, kind: 'type-only', change: 'added' },
      ],
    })
    expect(changeFromAnalysis(typeFlip, 1)).toBe('code')
  })
  it('is architecture when a module, its subsystem or an edge changed', () => {
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
    expect(
      changeFromAnalysis(
        analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'a')], {
          imports: [
            { ...importFact, change: 'unchanged' },
            { ...importFact, target: 'src/c.ts', specifier: './c', change: 'removed' },
          ],
        }),
        0,
      ),
    ).toBe('architecture')
    expect(
      changeFromAnalysis(
        analysis([module('src/a.ts', 'a')], [module('src/a.ts', 'a')], {
          imports: [
            { ...external, change: 'removed' },
            { ...external, resolution: 'unresolved', change: 'added' },
          ],
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
  const edgeSets: readonly (readonly string[] | null)[] = [
    [],
    ['src/x.ts'],
    ['src/y.ts'],
    ['src/x.ts', 'src/y.ts'],
    null,
  ]
  const generate = (seed: number) => {
    const next = random(seed)
    const count = Math.floor(next() * 5)
    const entries: CommitDiffEntry[] = []
    const table = new Map<string, readonly string[] | null>()
    for (let index = 0; index < count; index += 1) {
      const status = pick(next, statuses)
      const before = status === 'A' ? NONE : blob(`b${seed}-${index}`)
      const after = status === 'D' ? NONE : blob(`a${seed}-${index}`)
      const path = pick(next, paths)
      entries.push({ path, status, before, after })
      if (next() < 0.85) table.set(edgeKey(PARENT, path, before), pick(next, edgeSets))
      if (next() < 0.85) table.set(edgeKey(COMMIT, path, after), pick(next, edgeSets))
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
      const change = classifyCommitChange(diff(entries), layout, table)
      if (!touchesScope(entries)) expect(change).toBe('none')
      else expect(change).not.toBe('none')
    }
  })
  it('does not depend on entry order', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const { entries, table } = generate(seed)
      const reversed = [...entries].reverse()
      expect(classifyCommitChange(diff(reversed), layout, table)).toBe(
        classifyCommitChange(diff(entries), layout, table),
      )
    }
  })
  it('is code only when every in-scope change is a modification with equal imports', () => {
    let codeCases = 0
    for (let seed = 1; seed <= 400; seed += 1) {
      const { entries, table } = generate(seed)
      if (classifyCommitChange(diff(entries), layout, table) !== 'code') continue
      codeCases += 1
      for (const e of entries.filter((candidate) => touchesScope([candidate]))) {
        expect(['M', 'T']).toContain(e.status)
        expect(table.get(edgeKey(PARENT, e.path, e.before))).toBeDefined()
        expect(table.get(edgeKey(COMMIT, e.path, e.after))).toBeDefined()
      }
    }
    expect(codeCases).toBeGreaterThan(0)
  })
})
