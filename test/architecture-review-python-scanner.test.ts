import { beforeAll, describe, expect, it } from 'vitest'
import type { ArchitectureImportFact } from '../src/shared/architecture-analysis'
import { scanArchitecture } from '../src/main/architecture-review/analysis'
import type { ScannerSet } from '../src/main/architecture-review/language-scanner'
import { TYPESCRIPT_ONLY_SCANNERS } from '../src/main/architecture-review/typescript-scanner'
import { loadInstalledScanners, pythonFixture } from './architecture-scanner-fixtures'

let scanners: ScannerSet
beforeAll(async () => {
  scanners = await loadInstalledScanners()
})

const python = () => scanners.scannerFor('app/core/engine.py')!.scanner
const fixtureFile = (path: string) => pythonFixture().find((file) => file.path === path)!
const scan = () =>
  scanArchitecture({ files: pythonFixture(), scope: 'fixture', exclusions: [] }, scanners)
const importsOf = (source: string) =>
  scan()
    .imports.filter((fact) => fact.source === source)
    .map(({ specifier, form, kind, resolution, target, line }) => ({
      specifier,
      form,
      kind,
      resolution,
      target,
      line,
    }))
const fact = (
  line: number,
  specifier: string,
  resolution: ArchitectureImportFact['resolution'],
  target?: string,
  patch: Partial<ArchitectureImportFact> = {},
) => ({
  specifier,
  form: 'import' as ArchitectureImportFact['form'],
  kind: 'runtime' as ArchitectureImportFact['kind'],
  resolution,
  target,
  line,
  ...patch,
})
const from = (
  line: number,
  specifier: string,
  resolution: ArchitectureImportFact['resolution'],
  target?: string,
  patch: Partial<ArchitectureImportFact> = {},
) => fact(line, specifier, resolution, target, { form: 'from-import', ...patch })

describe('Python scanner on web-tree-sitter', () => {
  it('claims .py files as modules and names its parse kind and version', () => {
    expect(scanners.scannerFor('pkg/mod.py')).toMatchObject({ kind: '.py' })
    expect(scanners.scannerFor('pkg/mod.pyi')).toBeUndefined()
    expect(python().language).toBe('python')
    expect(python().version).toMatch(/^python-facts-\d+\+wasm-[0-9a-f]{16}$/)
  })

  it('extracts imports, from-imports and relative imports as written', () => {
    const facts = python().parse(
      'app/core/engine.py',
      fixtureFile('app/core/engine.py').content,
    )
    expect(facts.diagnostics).toEqual([])
    expect(
      facts.imports.map(({ specifier, form, names, typeOnly, line, column }) => [
        specifier,
        form,
        names ?? null,
        typeOnly,
        line,
        column,
      ]),
    ).toEqual([
      ['os', 'import', null, false, 1, 1],
      ['app.util.text', 'import', null, false, 2, 1],
      ['typing', 'from-import', ['TYPE_CHECKING'], false, 3, 1],
      ['.', 'from-import', ['models'], false, 5, 1],
      ['..util', 'from-import', ['text'], false, 6, 1],
      ['..util.text', 'from-import', ['slug'], false, 7, 1],
      ['.models', 'from-import', ['*'], false, 8, 1],
      ['.missing', 'from-import', ['nothing'], false, 9, 1],
      ['app.core.models', 'from-import', ['Model'], true, 12, 5],
      ['json', 'import', null, false, 17, 9],
    ])
    expect(facts.symbols).toEqual([
      { name: 'Engine', line: 15, kind: 'class' },
      { name: 'run', line: 16, kind: 'function' },
      { name: 'build', line: 22, kind: 'function' },
    ])
  })

  it('reports a syntax error as a diagnostic and keeps the imports around it', () => {
    const facts = python().parse('app/broken.py', fixtureFile('app/broken.py').content)
    expect(facts.diagnostics.length).toBeGreaterThan(0)
    expect(facts.diagnostics[0]!.line).toBe(3)
    expect(facts.diagnostics[0]!.message).toMatch(/^Syntax error|^Missing /)
    expect(facts.imports.map((entry) => [entry.specifier, entry.line])).toEqual([
      ['.util', 1],
      ['.core', 6],
    ])
    const scanned = scan()
    expect(scanned.modules.map((module) => module.path)).toContain('app/broken.py')
    expect(scanned.diagnostics.some((entry) => entry.file === 'app/broken.py')).toBe(true)
  })

  it('treats every file as a module in the subsystem of its first directory', () => {
    expect(scan().modules.map(({ path, subsystem }) => [path, subsystem])).toEqual([
      ['app/__init__.py', 'app'],
      ['app/broken.py', 'app'],
      ['app/core/__init__.py', 'app'],
      ['app/core/engine.py', 'app'],
      ['app/core/models.py', 'app'],
      ['app/util/__init__.py', 'app'],
      ['app/util/text.py', 'app'],
      ['scripts/helpers.py', 'scripts'],
      ['scripts/run.py', 'scripts'],
    ])
  })

  it('resolves relative imports against the package and names a submodule when imported', () => {
    expect(importsOf('app/core/engine.py')).toEqual([
      fact(1, 'os', 'external'),
      fact(2, 'app.util.text', 'internal', 'app/util/text.py'),
      from(3, 'typing', 'external'),
      from(5, '.models', 'internal', 'app/core/models.py'),
      from(6, '..util.text', 'internal', 'app/util/text.py'),
      from(7, '..util.text', 'internal', 'app/util/text.py'),
      from(8, '.models', 'internal', 'app/core/models.py'),
      from(9, '.missing', 'unresolved'),
      from(12, 'app.core.models', 'internal', 'app/core/models.py', {
        kind: 'type-only',
      }),
      fact(17, 'json', 'external'),
    ])
  })

  it("resolves a package's own __init__.py imports and from-imports of the package", () => {
    expect(importsOf('app/__init__.py')).toEqual([
      from(1, '.core.engine', 'internal', 'app/core/engine.py'),
    ])
    expect(importsOf('scripts/run.py')).toEqual([
      fact(1, 'app', 'internal', 'app/__init__.py'),
      fact(2, 'helpers', 'internal', 'scripts/helpers.py'),
      fact(3, 'requests', 'external'),
      from(4, 'app.core.engine', 'internal', 'app/core/engine.py'),
      from(4, 'app.core', 'internal', 'app/core/__init__.py'),
      from(5, '....', 'unresolved'),
    ])
  })

  it('counts relationships between package directories', () => {
    const scanned = scan()
    const edges = new Set(
      scanned.imports
        .filter((entry) => entry.resolution === 'internal')
        .map((entry) => `${entry.source} -> ${entry.target}`),
    )
    expect(edges).toContain('app/core/engine.py -> app/util/text.py')
    expect(edges).toContain('scripts/run.py -> app/__init__.py')
  })

  it('scans TypeScript and Python side by side without mixing their diagnostics', () => {
    const scanned = scanArchitecture(
      {
        files: [
          ...pythonFixture(),
          { path: 'web/a.ts', content: "import './b'\n" },
          { path: 'web/b.ts', content: 'export const b = 1\n' },
        ],
        scope: 'fixture',
        exclusions: [],
      },
      scanners,
    )
    expect(scanned.modules).toHaveLength(11)
    expect(scanned.imports.find((entry) => entry.source === 'web/a.ts')).toMatchObject({
      target: 'web/b.ts',
      resolution: 'internal',
    })
    const compiler = scanned.diagnostics.find((entry) =>
      entry.message.startsWith('Compiler options are not applied'),
    )
    expect(compiler?.message).toMatch(/^Compiler options are not applied to this scan/)
  })

  it('discloses files no loaded scanner reads instead of dropping them silently', () => {
    const scanned = scanArchitecture(
      { files: pythonFixture(), scope: 'fixture', exclusions: [] },
      TYPESCRIPT_ONLY_SCANNERS,
    )
    expect(scanned.modules).toEqual([])
    expect(scanned.diagnostics).toContainEqual({
      file: '(capture)',
      line: 1,
      message: '9 captured source file(s) have no loaded scanner and were not scanned.',
    })
  })
})
