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
import { isModuleFacts } from '../src/main/architecture-review/module-facts'
import { loadInstalledScanners, rustFixture } from './architecture-scanner-fixtures'

let scanners: ScannerSet
beforeAll(async () => {
  scanners = await loadInstalledScanners()
})

const rust = () => scanners.scannerFor('shop/src/lib.rs')!.scanner
const fixtureFile = (path: string) => rustFixture().find((file) => file.path === path)!
const parse = (path: string) => rust().parse(path, fixtureFile(path).content)

/** Splits the tree the way a capture does: sources are scanned, Cargo.toml files configure. */
function rustInput(files: readonly ArchitectureSourceFile[]): ArchitectureScanInput {
  return {
    files: files.filter((file) => isSource(file.path)),
    configs: files.filter((file) => !isSource(file.path)),
    scope: 'fixture',
    exclusions: [],
  }
}
const scan = (files = rustFixture()) => scanArchitecture(rustInput(files), scanners)
const importsOf = (source: string, files = rustFixture()) =>
  scan(files)
    .imports.filter((fact) => fact.source === source)
    .map(({ line, specifier, form, resolution, target }) => ({
      line,
      specifier,
      form,
      resolution,
      target,
    }))
const fact = (
  line: number,
  specifier: string,
  form: ArchitectureImportFact['form'],
  resolution: ArchitectureImportFact['resolution'],
  target?: string,
) => ({ line, specifier, form, resolution, target })

describe('Rust scanner on web-tree-sitter', () => {
  it('claims .rs files as modules and names its parse kind and version', () => {
    expect(scanners.scannerFor('shop/src/store/mod.rs')).toMatchObject({ kind: '.rs' })
    expect(scanners.scannerFor('shop/Cargo.toml')).toBeUndefined()
    expect(rust().language).toBe('rust')
    expect(rust().version).toMatch(/^rust-facts-\d+\+wasm-[0-9a-f]{16}$/)
  })

  it('extracts mod declarations, use trees and extern crates with their positions', () => {
    const facts = parse('shop/src/lib.rs')
    expect(facts.diagnostics).toEqual([])
    expect(
      facts.imports.map(
        ({ specifier, form, names, scope, pathAttribute, line, column }) => ({
          specifier,
          form,
          names,
          scope,
          pathAttribute,
          line,
          column,
        }),
      ),
    ).toEqual([
      { specifier: 'api', form: 'mod', line: 2, column: 1 },
      { specifier: 'store', form: 'mod', line: 3, column: 1 },
      { specifier: 'broken', form: 'mod', line: 4, column: 1 },
      { specifier: 'missing', form: 'mod', line: 5, column: 1 },
      {
        specifier: 'codes',
        form: 'mod',
        pathAttribute: 'generated/codes.rs',
        line: 7,
        column: 1,
      },
      { specifier: 'fmt', form: 'mod', scope: ['util'], line: 10, column: 5 },
      {
        specifier: 'crate::store::Store',
        form: 'export',
        names: ['crate::store::Store'],
        line: 18,
        column: 1,
      },
    ])
    expect(
      parse('cli/src/main.rs').imports.map(({ specifier, names }) => [specifier, names]),
    ).toEqual([
      ['shop_core', undefined],
      ['commands', undefined],
      ['::std::env', ['::std::env']],
      ['clap::Parser as _', ['clap::Parser as _']],
      [
        'shop_core::{api, store::Store as ShopStore}',
        ['shop_core::api', 'shop_core::store::Store as ShopStore'],
      ],
    ])
    expect(parse('shop/src/store/sqlite.rs').imports[0]!.names).toEqual([
      'crate::api::self',
      'crate::api::v1::Handler',
    ])
    expect(parse('shop/src/api/v1.rs').imports[0]!.names).toEqual(['super::*'])
  })

  it('keeps mod declarations, inline scopes and #[path] valid for the parse cache', () => {
    const stored: unknown = JSON.parse(JSON.stringify(parse('shop/src/lib.rs')))
    expect(isModuleFacts(stored)).toBe(true)
    const facts = parse('shop/src/lib.rs')
    const withImport = (entry: Record<string, unknown>) => ({
      ...facts,
      imports: [{ ...facts.imports[0], ...entry }],
    })
    expect(isModuleFacts(withImport({ scope: 'util' }))).toBe(false)
    expect(isModuleFacts(withImport({ pathAttribute: 7 }))).toBe(false)
    expect(isModuleFacts(withImport({ externCrate: 'yes' }))).toBe(false)
    expect(isModuleFacts(withImport({ local: 'yes' }))).toBe(false)
    expect(isModuleFacts(withImport({ blockScope: 'inner' }))).toBe(false)
    expect(isModuleFacts(withImport({ form: 'include' }))).toBe(false)
  })

  it('lists top-level items and inline modules, not items inside impls or functions', () => {
    expect(parse('shop/src/lib.rs').symbols).toEqual([
      { name: 'util', line: 9, kind: 'module' },
      { name: 'errors', line: 13, kind: 'module' },
      { name: 'version', line: 20, kind: 'function' },
    ])
    expect(parse('shop/src/store/mod.rs').symbols).toEqual([
      { name: 'Store', line: 11, kind: 'struct' },
    ])
    expect(parse('shop/src/api.rs').symbols).toEqual([
      { name: 'NAME', line: 6, kind: 'const' },
      { name: 'lookup', line: 8, kind: 'function' },
    ])
  })

  it('records items inside inline modules by their scope, valid for the parse cache', () => {
    const facts = rust().parse(
      'shop/src/x.rs',
      'mod a {\n    pub struct S;\n    pub mod b { pub fn f() {} }\n    impl S { fn m() {} }\n}\n',
    )
    expect(facts.inlineItems).toEqual([
      { scope: ['a'], name: 'S', kind: 'struct' },
      { scope: ['a'], name: 'b', kind: 'module' },
      { scope: ['a', 'b'], name: 'f', kind: 'function' },
    ])
    expect(isModuleFacts(JSON.parse(JSON.stringify(facts)))).toBe(true)
    const item = facts.inlineItems![0]!
    for (const inlineItems of [
      [{ ...item, scope: 'a' }],
      [{ ...item, name: 7 }],
      [{ ...item, kind: null }],
      'S',
    ])
      expect(isModuleFacts({ ...facts, inlineItems })).toBe(false)
  })

  it('reports a syntax error as a diagnostic and keeps the imports before it', () => {
    const facts = parse('shop/src/broken.rs')
    expect(facts.diagnostics.length).toBeGreaterThan(0)
    expect(facts.diagnostics[0]!.message).toMatch(/^Syntax error|^Missing /)
    expect(facts.imports[0]).toMatchObject({ specifier: 'crate::store::Store', line: 1 })
    expect(scan().diagnostics.some((entry) => entry.file === 'shop/src/broken.rs')).toBe(
      true,
    )
  })

  it('keeps every file as a module in the subsystem of its first directory', () => {
    expect(scan().modules.map(({ path, subsystem }) => [path, subsystem])).toEqual([
      ['cli/src/commands.rs', 'cli'],
      ['cli/src/commands/helpers.rs', 'cli'],
      ['cli/src/main.rs', 'cli'],
      ['shop/src/api.rs', 'shop'],
      ['shop/src/api/v1.rs', 'shop'],
      ['shop/src/bin/seed.rs', 'shop'],
      ['shop/src/broken.rs', 'shop'],
      ['shop/src/generated/codes.rs', 'shop'],
      ['shop/src/lib.rs', 'shop'],
      ['shop/src/orphan.rs', 'shop'],
      ['shop/src/store/mod.rs', 'shop'],
      ['shop/src/store/sqlite.rs', 'shop'],
      ['shop/src/util/fmt.rs', 'shop'],
      ['shop/tests/smoke.rs', 'shop'],
    ])
  })

  it('resolves mod declarations to files by mod.rs, non-mod-rs, inline and #[path] rules', () => {
    expect(importsOf('shop/src/lib.rs')).toEqual([
      fact(2, 'api', 'mod', 'internal', 'shop/src/api.rs'),
      fact(3, 'store', 'mod', 'internal', 'shop/src/store/mod.rs'),
      fact(4, 'broken', 'mod', 'internal', 'shop/src/broken.rs'),
      fact(5, 'missing', 'mod', 'unresolved'),
      fact(7, 'codes', 'mod', 'internal', 'shop/src/generated/codes.rs'),
      fact(10, 'fmt', 'mod', 'internal', 'shop/src/util/fmt.rs'),
      fact(18, 'crate::store::Store', 'export', 'internal', 'shop/src/store/mod.rs'),
    ])
    expect(importsOf('shop/src/api.rs')[0]).toEqual(
      fact(1, 'v1', 'mod', 'internal', 'shop/src/api/v1.rs'),
    )
    expect(importsOf('cli/src/commands.rs')[2]).toEqual(
      fact(4, 'helpers', 'mod', 'internal', 'cli/src/commands/helpers.rs'),
    )
  })

  it('resolves crate, self and super paths through the crate module tree', () => {
    expect(importsOf('shop/src/store/mod.rs')).toEqual([
      fact(1, 'sqlite', 'mod', 'internal', 'shop/src/store/sqlite.rs'),
      fact(3, 'std::collections::HashMap', 'import', 'external'),
      fact(5, 'serde::Serialize', 'import', 'external'),
      fact(7, 'self::sqlite::Pool', 'import', 'internal', 'shop/src/store/sqlite.rs'),
      fact(8, 'super::errors::Error', 'import', 'internal', 'shop/src/lib.rs'),
    ])
    expect(importsOf('shop/src/store/sqlite.rs')).toEqual([
      fact(1, 'crate::api::{self, v1::Handler}', 'import', 'internal', 'shop/src/api.rs'),
      fact(
        1,
        'crate::api::{self, v1::Handler}',
        'import',
        'internal',
        'shop/src/api/v1.rs',
      ),
      fact(
        2,
        'super::super::util::fmt::render',
        'import',
        'internal',
        'shop/src/util/fmt.rs',
      ),
    ])
    expect(importsOf('shop/src/api.rs').slice(1)).toEqual([
      fact(3, 'crate::nowhere::Thing', 'import', 'unresolved'),
      fact(
        4,
        'crate::{codes::NOT_FOUND, Store}',
        'import',
        'internal',
        'shop/src/generated/codes.rs',
      ),
      fact(
        4,
        'crate::{codes::NOT_FOUND, Store}',
        'import',
        'internal',
        'shop/src/lib.rs',
      ),
    ])
    expect(importsOf('shop/src/api/v1.rs')).toEqual([
      fact(1, 'super::*', 'import', 'internal', 'shop/src/api.rs'),
      fact(2, 'crate::errors::Error', 'import', 'internal', 'shop/src/lib.rs'),
    ])
    expect(importsOf('cli/src/commands.rs').slice(0, 2)).toEqual([
      fact(1, 'super::Args', 'import', 'internal', 'cli/src/main.rs'),
      fact(
        2,
        'crate::commands::helpers::assist',
        'import',
        'internal',
        'cli/src/commands/helpers.rs',
      ),
    ])
  })

  it('resolves a repository crate by its library name and leaves extern crates external', () => {
    expect(importsOf('cli/src/main.rs')).toEqual([
      fact(1, 'shop_core', 'import', 'internal', 'shop/src/lib.rs'),
      fact(3, 'commands', 'mod', 'internal', 'cli/src/commands.rs'),
      fact(5, '::std::env', 'import', 'external'),
      fact(6, 'clap::Parser as _', 'import', 'external'),
      fact(
        7,
        'shop_core::{api, store::Store as ShopStore}',
        'import',
        'internal',
        'shop/src/api.rs',
      ),
      fact(
        7,
        'shop_core::{api, store::Store as ShopStore}',
        'import',
        'internal',
        'shop/src/store/mod.rs',
      ),
    ])
    expect(importsOf('shop/src/bin/seed.rs')).toEqual([
      fact(1, 'shop_core::store::Store', 'import', 'internal', 'shop/src/store/mod.rs'),
      fact(2, 'shop_core::version', 'import', 'internal', 'shop/src/lib.rs'),
    ])
    expect(importsOf('shop/tests/smoke.rs')).toEqual([
      fact(1, 'shop_core::api::v1::handle', 'import', 'internal', 'shop/src/api/v1.rs'),
    ])
  })

  it('discloses a file no crate root reaches and leaves its crate paths unresolved', () => {
    expect(importsOf('shop/src/orphan.rs')).toEqual([
      fact(1, 'crate::store::Store', 'import', 'unresolved'),
    ])
    expect(scan().diagnostics).toContainEqual({
      file: 'shop/src/orphan.rs',
      line: 1,
      message:
        'No crate root reaches this file through mod declarations, so its crate and super paths are unresolved.',
    })
  })

  it('counts imports between subsystems through the repository crate', () => {
    const scanned = scan()
    const analysis = compareArchitecture(scanned, scanned)
    const cliToShop = analysis.relationships.find(
      (r) => r.source === 'cli' && r.target === 'shop',
    )!
    expect(cliToShop.after).toBe(3)
    expect(
      analysis.relationships.some((r) => r.source === 'shop' && r.target === 'cli'),
    ).toBe(false)
  })

  it('discloses a scan with Rust sources and no Cargo package', () => {
    const files = rustFixture().filter((file) => !file.path.endsWith('Cargo.toml'))
    expect(importsOf('shop/src/broken.rs', files)).toEqual([
      fact(1, 'crate::store::Store', 'import', 'unresolved'),
    ])
    expect(importsOf('shop/src/bin/seed.rs', files)[0]!.resolution).toBe('external')
    expect(importsOf('shop/src/lib.rs', files)[0]).toEqual(
      fact(2, 'api', 'mod', 'internal', 'shop/src/api.rs'),
    )
    expect(scan(files).diagnostics).toContainEqual({
      file: '(capture)',
      line: 1,
      message:
        'No Cargo.toml with a [package] was captured, so no Rust file is placed in a crate; crate paths are unresolved and every other path is classified as external.',
    })
  })

  it('discloses a package manifest without a name and does not treat it as a crate', () => {
    const files = rustFixture().map((file) =>
      file.path === 'shop/Cargo.toml'
        ? { ...file, content: '[package]\nversion = "0.1.0"\n' }
        : file,
    )
    expect(scan(files).diagnostics).toContainEqual({
      file: 'shop/Cargo.toml',
      line: 1,
      message: 'This Cargo.toml [package] has no name, so its crate is not resolved.',
    })
    expect(importsOf('cli/src/main.rs', files)[0]).toEqual(
      fact(1, 'shop_core', 'import', 'external'),
    )
  })

  it('honours a [lib] name and path in the package manifest', () => {
    const files = rustFixture().map((file) =>
      file.path === 'shop/Cargo.toml'
        ? {
            ...file,
            content:
              '[package]\nname = "shop-core" # the package\n\n[lib]\nname = "shop"\npath = "src/lib.rs"\n',
          }
        : file,
    )
    expect(importsOf('cli/src/main.rs', files)[0]).toEqual(
      fact(1, 'shop_core', 'import', 'external'),
    )
    expect(importsOf('shop/src/bin/seed.rs', files)[0]!.resolution).toBe('external')
    const renamed = files.map((file) =>
      file.path === 'cli/src/main.rs'
        ? { ...file, content: file.content.replace(/shop_core/g, 'shop') }
        : file,
    )
    expect(importsOf('cli/src/main.rs', renamed)[0]).toEqual(
      fact(1, 'shop', 'import', 'internal', 'shop/src/lib.rs'),
    )
  })
})
