import { beforeAll, describe, expect, it } from 'vitest'
import type {
  ArchitectureImportFact,
  ArchitectureScanInput,
  ArchitectureSourceFile,
} from '../src/shared/architecture-analysis'
import {
  compareArchitecture,
  scanArchitecture,
} from '../src/main/architecture-review/analysis'
import { isSource } from '../src/main/architecture-review/capture-entries'
import type { ScannerSet } from '../src/main/architecture-review/language-scanner'
import { goFixture, loadInstalledScanners } from './architecture-scanner-fixtures'

let scanners: ScannerSet
beforeAll(async () => {
  scanners = await loadInstalledScanners()
})

const go = () => scanners.scannerFor('cmd/shop/main.go')!.scanner
const fixtureFile = (path: string) => goFixture().find((file) => file.path === path)!

/** Splits the tree the way a capture does: sources are scanned, go.mod files configure. */
function goInput(files: readonly ArchitectureSourceFile[]): ArchitectureScanInput {
  return {
    files: files.filter((file) => isSource(file.path)),
    configs: files.filter((file) => !isSource(file.path)),
    scope: 'fixture',
    exclusions: [],
  }
}
const scan = (files = goFixture()) => scanArchitecture(goInput(files), scanners)
const importsOf = (source: string, files = goFixture()) =>
  scan(files)
    .imports.filter((fact) => fact.source === source)
    .map(({ specifier, resolution, target, line }) => ({
      specifier,
      resolution,
      target,
      line,
    }))
const fact = (
  line: number,
  specifier: string,
  resolution: ArchitectureImportFact['resolution'],
  target?: string,
) => ({ specifier, resolution, target, line })

describe('Go scanner on web-tree-sitter', () => {
  it('claims .go files as modules and names its parse kind and version', () => {
    expect(scanners.scannerFor('internal/store/store.go')).toMatchObject({ kind: '.go' })
    expect(scanners.scannerFor('go.mod')).toBeUndefined()
    expect(go().language).toBe('go')
    expect(go().version).toMatch(/^go-facts-\d+\+wasm-[0-9a-f]{16}$/)
  })

  it('extracts every import spec as written, with its own position', () => {
    const facts = go().parse('cmd/shop/main.go', fixtureFile('cmd/shop/main.go').content)
    expect(facts.diagnostics).toEqual([])
    expect(
      facts.imports.map(({ specifier, form, typeOnly, line, column }) => [
        specifier,
        form,
        typeOnly,
        line,
        column,
      ]),
    ).toEqual([
      ['fmt', 'import', false, 3, 8],
      ['example.com/shop', 'import', false, 6, 2],
      ['example.com/shop/internal/store', 'import', false, 7, 2],
      ['example.com/shop/pkg/api', 'import', false, 8, 2],
      ['github.com/google/uuid', 'import', false, 9, 2],
      ['example.com/shop/internal/missing', 'import', false, 10, 2],
      ['example.com/shop/internal/store/sqlite', 'import', false, 11, 2],
      ['example.com/shop/hack/tmpl', 'import', false, 12, 2],
    ])
  })

  it('lists top-level functions, methods and types, not local declarations', () => {
    const store = go().parse(
      'internal/store/store.go',
      fixtureFile('internal/store/store.go').content,
    )
    expect(store.symbols).toEqual([
      { name: 'Store', line: 9, kind: 'type' },
      { name: 'Key', line: 11, kind: 'type' },
      { name: 'New', line: 13, kind: 'function' },
      { name: 'Get', line: 15, kind: 'method' },
    ])
    const api = go().parse('pkg/api/api.go', fixtureFile('pkg/api/api.go').content)
    expect(api.symbols).toEqual([
      { name: 'Item', line: 4, kind: 'type' },
      { name: 'ID', line: 5, kind: 'type' },
      { name: 'Handle', line: 8, kind: 'function' },
    ])
  })

  it('reports a syntax error as a diagnostic and keeps the imports before it', () => {
    const facts = go().parse(
      'pkg/api/broken.go',
      fixtureFile('pkg/api/broken.go').content,
    )
    expect(facts.diagnostics.length).toBeGreaterThan(0)
    expect(facts.diagnostics[0]!.message).toMatch(/^Syntax error|^Missing /)
    expect(facts.imports[0]).toMatchObject({ specifier: 'strings', line: 3 })
    const scanned = scan()
    expect(scanned.modules.map((module) => module.path)).toContain('pkg/api/broken.go')
    expect(scanned.diagnostics.some((entry) => entry.file === 'pkg/api/broken.go')).toBe(
      true,
    )
  })

  it('keeps every file as a module in the subsystem of its first directory', () => {
    expect(scan().modules.map(({ path, subsystem }) => [path, subsystem])).toEqual([
      ['cmd/shop/main.go', 'cmd'],
      ['doc.go', '(repository root)'],
      ['hack/gen/gen.go', 'hack'],
      ['hack/tmpl/tmpl.go', 'hack'],
      ['internal/store/sqlite/sqlite.go', 'internal'],
      ['internal/store/store_test.go', 'internal'],
      ['internal/store/store.go', 'internal'],
      ['pkg/api/api.go', 'pkg'],
      ['pkg/api/broken.go', 'pkg'],
    ])
  })

  it('resolves module-path imports to package directories and the rest as external', () => {
    expect(importsOf('cmd/shop/main.go')).toEqual([
      fact(3, 'fmt', 'external'),
      fact(6, 'example.com/shop', 'internal', '.'),
      fact(7, 'example.com/shop/internal/store', 'internal', 'internal/store'),
      fact(8, 'example.com/shop/pkg/api', 'internal', 'pkg/api'),
      fact(9, 'github.com/google/uuid', 'external'),
      fact(10, 'example.com/shop/internal/missing', 'unresolved'),
      fact(
        11,
        'example.com/shop/internal/store/sqlite',
        'internal',
        'internal/store/sqlite',
      ),
      fact(12, 'example.com/shop/hack/tmpl', 'unresolved'),
    ])
    expect(importsOf('internal/store/store_test.go')).toEqual([
      fact(4, 'testing', 'external'),
      fact(6, 'example.com/shop/internal/store', 'internal', 'internal/store'),
    ])
  })

  it('resolves against the longest module path among every captured go.mod', () => {
    expect(importsOf('hack/gen/gen.go')).toEqual([
      fact(4, 'example.com/shop/pkg/api', 'internal', 'pkg/api'),
      fact(5, 'example.com/shop/tools/tmpl', 'internal', 'hack/tmpl'),
      fact(6, 'C', 'external'),
    ])
  })

  it('counts imports between subsystems, with a package directory as the target', () => {
    const scanned = scan()
    const analysis = compareArchitecture(scanned, scanned)
    expect(analysis.relationships.map(({ source, target }) => [source, target])).toEqual(
      expect.arrayContaining([
        ['cmd', '(repository root)'],
        ['cmd', 'internal'],
        ['cmd', 'pkg'],
        ['hack', 'pkg'],
        ['internal', 'pkg'],
      ]),
    )
    expect(
      analysis.relationships.find((r) => r.source === 'cmd' && r.target === 'internal')!
        .after,
    ).toBe(2)
  })

  it('discloses a scan with Go sources and no go.mod, and calls every import external', () => {
    const files = goFixture().filter((file) => !file.path.endsWith('go.mod'))
    expect(importsOf('cmd/shop/main.go', files).map((entry) => entry.resolution)).toEqual(
      Array(8).fill('external'),
    )
    expect(scan(files).diagnostics).toContainEqual({
      file: '(capture)',
      line: 1,
      message:
        'No go.mod was captured, so no Go import can be matched to a package in this repository; every Go import is classified as external.',
    })
  })

  it('discloses a go.mod without a module directive and matches nothing to it', () => {
    const files = goFixture().map((file) =>
      file.path === 'hack/go.mod' ? { ...file, content: 'go 1.22\n' } : file,
    )
    expect(scan(files).diagnostics).toContainEqual({
      file: 'hack/go.mod',
      line: 1,
      message: 'This go.mod names no module, so imports of its packages are not matched.',
    })
    expect(importsOf('hack/gen/gen.go', files)[1]).toEqual(
      fact(5, 'example.com/shop/tools/tmpl', 'unresolved'),
    )
  })
})
