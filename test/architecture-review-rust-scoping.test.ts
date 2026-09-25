import { beforeAll, describe, expect, it } from 'vitest'
import type { ArchitectureSourceFile } from '../src/shared/architecture-analysis'
import { scanArchitecture } from '../src/main/architecture-review/analysis'
import { isSource } from '../src/main/architecture-review/capture-entries'
import type { ScannerSet } from '../src/main/architecture-review/language-scanner'
import { isModuleFacts } from '../src/main/architecture-review/module-facts'
import { loadInstalledScanners, rustFixture } from './architecture-scanner-fixtures'

let scanners: ScannerSet
beforeAll(async () => {
  scanners = await loadInstalledScanners()
})

const fixtureContent = (path: string) =>
  rustFixture().find((file) => file.path === path)!.content

/** The fixture workspace with some files replaced or added. */
function withFiles(replaced: Readonly<Record<string, string>>): ArchitectureSourceFile[] {
  const kept = rustFixture().filter((file) => !(file.path in replaced))
  return [
    ...kept,
    ...Object.entries(replaced).map(([path, content]) => ({ path, content })),
  ]
}

function scan(files: readonly ArchitectureSourceFile[]) {
  return scanArchitecture(
    {
      files: files.filter((file) => isSource(file.path)),
      configs: files.filter((file) => !isSource(file.path)),
      scope: 'fixture',
      exclusions: [],
    },
    scanners,
  )
}

/** Each named specifier's resolution and target, in source order. */
const resolutionsOf = (
  files: readonly ArchitectureSourceFile[],
  source: string,
  specifiers: readonly string[],
) =>
  scan(files)
    .imports.filter(
      (fact) => fact.source === source && specifiers.includes(fact.specifier),
    )
    .map(({ specifier, resolution, target }) => ({ specifier, resolution, target }))

const internal = (specifier: string, target: string) => ({
  specifier,
  resolution: 'internal',
  target,
})
const external = (specifier: string) => ({
  specifier,
  resolution: 'external',
  target: undefined,
})
const unresolved = (specifier: string) => ({
  specifier,
  resolution: 'unresolved',
  target: undefined,
})

const MAIN = 'cli/src/main.rs'
/** The CLI root without its own `extern crate shop_core;`, which binds `shop_core`. */
const withoutExternCrate = (path: string) =>
  fixtureContent(path).replace('extern crate shop_core;\n', '')
const COMMANDS = 'cli/src/commands.rs'

describe('Rust extern crate aliases', () => {
  it('resolves a path through an alias of a repository crate to that crate', () => {
    const files = withFiles({
      [MAIN]: `extern crate shop_core as sc;\nuse sc::version;\nuse sc::api::v1::handle;\nuse sc::nothing;\n${fixtureContent(MAIN)}`,
    })
    expect(
      resolutionsOf(files, MAIN, [
        'shop_core',
        'sc::version',
        'sc::api::v1::handle',
        'sc::nothing',
      ]),
    ).toEqual([
      internal('shop_core', 'shop/src/lib.rs'),
      internal('sc::version', 'shop/src/lib.rs'),
      internal('sc::api::v1::handle', 'shop/src/api/v1.rs'),
      unresolved('sc::nothing'),
      internal('shop_core', 'shop/src/lib.rs'),
    ])
  })

  it('leaves a path through an alias of an external crate external', () => {
    const files = withFiles({
      [MAIN]: `extern crate clap as cl;\nuse cl::Parser;\n${fixtureContent(MAIN)}`,
    })
    expect(resolutionsOf(files, MAIN, ['clap', 'cl::Parser'])).toEqual([
      external('clap'),
      external('cl::Parser'),
    ])
  })

  it('lets a crate-root alias reach every module of the crate, as the extern prelude does', () => {
    const files = withFiles({
      [MAIN]: `extern crate shop_core as sc;\n${fixtureContent(MAIN)}`,
      [COMMANDS]: `use sc::store::Store;\n${fixtureContent(COMMANDS)}`,
    })
    expect(resolutionsOf(files, COMMANDS, ['sc::store::Store'])).toEqual([
      internal('sc::store::Store', 'shop/src/store/mod.rs'),
    ])
  })

  it('keeps an alias declared in a submodule out of its parent', () => {
    const files = withFiles({
      [COMMANDS]: `extern crate shop_core as local;\nuse local::version;\n${fixtureContent(COMMANDS)}`,
      [MAIN]: `use local::version;\n${fixtureContent(MAIN)}`,
    })
    expect(resolutionsOf(files, COMMANDS, ['local::version'])).toEqual([
      internal('local::version', 'shop/src/lib.rs'),
    ])
    expect(resolutionsOf(files, MAIN, ['local::version'])).toEqual([
      external('local::version'),
    ])
  })

  // A name a module binds is its item, as a re-export is: the path ends at the binding module.
  it('binds the alias, not the crate name, for paths through the declaring module', () => {
    const files = withFiles({
      [MAIN]: `extern crate shop_core as sc;\n${withoutExternCrate(MAIN)}`,
      [COMMANDS]: `use crate::sc::version;\nuse crate::shop_core::version as v;\n${fixtureContent(COMMANDS)}`,
    })
    expect(
      resolutionsOf(files, COMMANDS, [
        'crate::sc::version',
        'crate::shop_core::version as v',
      ]),
    ).toEqual([
      internal('crate::sc::version', MAIN),
      unresolved('crate::shop_core::version as v'),
    ])
  })

  it('resolves an alias of the crate itself to its own crate root', () => {
    const files = withFiles({
      [MAIN]: `extern crate self as me;\nuse me::commands::run;\n${fixtureContent(MAIN)}`,
    })
    expect(resolutionsOf(files, MAIN, ['self', 'me::commands::run'])).toEqual([
      internal('self', MAIN),
      internal('me::commands::run', COMMANDS),
    ])
  })
})

describe('Rust use declarations inside blocks', () => {
  const API = 'shop/src/api.rs'
  const PROBE = 'shop/src/util/fmt.rs'
  const withApi = (tail: string, probe: string) =>
    withFiles({ [API]: `${fixtureContent(API)}\n${tail}\n`, [PROBE]: probe })

  it('marks a declaration inside a block local and keeps it in its item-level module', () => {
    const facts = scanners
      .scannerFor(API)!
      .scanner.parse(
        API,
        'mod outer {\n    fn f() {\n        mod inner { use a::b; }\n        use c::d;\n    }\n    use e::f;\n}\n',
      )
    expect(
      facts.imports.map(({ specifier, scope, local }) => ({ specifier, scope, local })),
    ).toEqual([
      { specifier: 'a::b', scope: ['outer'], local: true },
      { specifier: 'c::d', scope: ['outer'], local: true },
      { specifier: 'e::f', scope: ['outer'], local: undefined },
    ])
    expect(isModuleFacts(JSON.parse(JSON.stringify(facts)))).toBe(true)
  })

  it('does not let a use inside a function body bind a name for other modules', () => {
    const files = withApi(
      'fn local() {\n    use crate::store::Store as Real;\n}',
      'use crate::api::Real;\n',
    )
    expect(resolutionsOf(files, PROBE, ['crate::api::Real'])).toEqual([
      unresolved('crate::api::Real'),
    ])
  })

  it('still counts a use inside a function body as an import of its file', () => {
    const files = withApi('fn local() {\n    use crate::store::Store as Real;\n}', '')
    expect(resolutionsOf(files, API, ['crate::store::Store as Real'])).toEqual([
      internal('crate::store::Store as Real', 'shop/src/store/mod.rs'),
    ])
  })

  it('keeps uses in method bodies, closures, const blocks and nested blocks local', () => {
    const files = withApi(
      [
        'pub struct Holder;',
        'impl Holder {',
        '    fn method() { use crate::store::Store as InMethod; }',
        '}',
        'const _: () = { use crate::store::Store as InConst; };',
        'fn closure() { let _ = || { use crate::store::Store as InClosure; }; }',
        'fn nested() { if true { { use crate::store::Store as InNested; } } }',
      ].join('\n'),
      [
        'use crate::api::InMethod;',
        'use crate::api::InConst;',
        'use crate::api::InClosure;',
        'use crate::api::InNested;',
        'use crate::api::Holder;',
      ].join('\n'),
    )
    expect(
      resolutionsOf(files, PROBE, [
        'crate::api::InMethod',
        'crate::api::InConst',
        'crate::api::InClosure',
        'crate::api::InNested',
        'crate::api::Holder',
      ]),
    ).toEqual([
      unresolved('crate::api::InMethod'),
      unresolved('crate::api::InConst'),
      unresolved('crate::api::InClosure'),
      unresolved('crate::api::InNested'),
      internal('crate::api::Holder', API),
    ])
  })

  it('keeps a use inside a function of an inline module out of that module', () => {
    const files = withApi(
      'pub mod inner {\n    pub fn f() { use crate::store::Store as Hidden; }\n    pub use crate::store::Store as Shown;\n}',
      'use crate::api::inner::Hidden;\nuse crate::api::inner::Shown;\n',
    )
    expect(
      resolutionsOf(files, PROBE, [
        'crate::api::inner::Hidden',
        'crate::api::inner::Shown',
      ]),
    ).toEqual([
      unresolved('crate::api::inner::Hidden'),
      internal('crate::api::inner::Shown', API),
    ])
  })

  it('does not make a module declared inside a function body a child of the file', () => {
    const files = withApi(
      'fn local() {\n    mod hidden {\n        pub use crate::store::Store;\n    }\n}',
      'use crate::api::hidden::Store;\n',
    )
    expect(resolutionsOf(files, PROBE, ['crate::api::hidden::Store'])).toEqual([
      unresolved('crate::api::hidden::Store'),
    ])
  })

  it('does not let an extern crate alias inside a function reach item-level paths', () => {
    const files = withFiles({
      [MAIN]: `fn local() { extern crate shop_core as inner_sc; }\nuse inner_sc::version;\n${fixtureContent(MAIN)}`,
    })
    expect(resolutionsOf(files, MAIN, ['inner_sc::version'])).toEqual([
      external('inner_sc::version'),
    ])
  })
})
