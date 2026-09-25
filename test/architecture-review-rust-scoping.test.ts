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
      facts.imports.map(({ specifier, scope, local, blockScope }) => ({
        specifier,
        scope,
        local,
        blockScope,
      })),
    ).toEqual([
      { specifier: 'a::b', scope: ['outer'], local: true, blockScope: ['inner'] },
      { specifier: 'c::d', scope: ['outer'], local: true, blockScope: undefined },
      { specifier: 'e::f', scope: ['outer'], local: undefined, blockScope: undefined },
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

describe('Rust #[path] modules declared inside blocks', () => {
  const LIB = 'shop/src/lib.rs'
  const B = 'shop/src/b.rs'
  const HID = 'shop/src/hid.rs'
  const withB = (b: string, extra: Readonly<Record<string, string>> = {}) =>
    withFiles({
      [LIB]: `${fixtureContent(LIB)}\npub mod b;\n`,
      [B]: b,
      [HID]: 'use crate::b;\nuse super::y;\n',
      ...extra,
    })
  const unreachedFiles = (files: readonly ArchitectureSourceFile[]) =>
    scan(files)
      .diagnostics.filter((entry) => entry.message.startsWith('No crate root reaches'))
      .map((entry) => entry.file)

  it('reaches the file a #[path] mod inside a function body loads', () => {
    const files = withB('pub fn y() {\n    #[path = "hid.rs"]\n    mod hid;\n}\n')
    expect(unreachedFiles(files)).not.toContain(HID)
    expect(resolutionsOf(files, B, ['hid'])).toEqual([internal('hid', HID)])
    expect(resolutionsOf(files, HID, ['crate::b', 'super::y'])).toEqual([
      internal('crate::b', B),
      internal('super::y', B),
    ])
  })

  it('does not bind a #[path] mod inside a function body as a child of the file', () => {
    const files = withB('pub fn y() {\n    #[path = "hid.rs"]\n    mod hid;\n}\n', {
      'shop/src/util/fmt.rs': 'use crate::b::hid;\n',
    })
    expect(resolutionsOf(files, 'shop/src/util/fmt.rs', ['crate::b::hid'])).toEqual([
      unresolved('crate::b::hid'),
    ])
  })

  it('leaves a mod without #[path] inside a function body unresolved, as rustc rejects it', () => {
    const files = withB('fn z() {\n    mod nopath;\n}\n', {
      'shop/src/b/nopath.rs': 'use crate::b;\n',
    })
    expect(resolutionsOf(files, B, ['nopath'])).toEqual([unresolved('nopath')])
    expect(unreachedFiles(files)).toContain('shop/src/b/nopath.rs')
  })

  it('places a #[path] file under an inline module inside a block by rustc directory rules', () => {
    const files = withB(
      [
        'pub fn y() {}',
        'fn w() {',
        '    mod inner {',
        '        #[path = "deep.rs"]',
        '        mod deep;',
        '    }',
        '}',
        'pub mod outer {',
        '    fn v() {',
        '        #[path = "under.rs"]',
        '        mod under;',
        '    }',
        '}',
      ].join('\n'),
      {
        'shop/src/inner/deep.rs': 'use crate::b::y;\nuse super::super::y;\n',
        'shop/src/b/outer/under.rs': 'use super::super::y;\n',
      },
    )
    expect(resolutionsOf(files, B, ['deep', 'under'])).toEqual([
      internal('deep', 'shop/src/inner/deep.rs'),
      internal('under', 'shop/src/b/outer/under.rs'),
    ])
    expect(unreachedFiles(files)).not.toContain('shop/src/inner/deep.rs')
    expect(
      resolutionsOf(files, 'shop/src/inner/deep.rs', ['crate::b::y', 'super::super::y']),
    ).toEqual([internal('crate::b::y', B), internal('super::super::y', B)])
    expect(
      resolutionsOf(files, 'shop/src/b/outer/under.rs', ['super::super::y']),
    ).toEqual([internal('super::super::y', B)])
  })
})

describe('Rust packages that build libraries of the same name', () => {
  const SEED = 'shop/src/bin/seed.rs'
  const VENDORED = {
    'vendored/shop/Cargo.toml': '[package]\nname = "shop_core"\nversion = "0.2.0"\n',
    'vendored/shop/src/lib.rs': 'pub fn version() -> &\'static str {\n    "2"\n}\n',
    'vendored/shop/src/bin/tool.rs': 'use shop_core::version;\n\nfn main() {}\n',
  }
  const DIAGNOSTIC = {
    file: 'shop/Cargo.toml',
    line: 1,
    message:
      'Several packages build a library named shop_core (shop/Cargo.toml, vendored/shop/Cargo.toml), so a path through shop_core is unresolved outside those packages.',
  }

  it('discloses the collision, naming both manifests', () => {
    expect(scan(withFiles(VENDORED)).diagnostics).toContainEqual(DIAGNOSTIC)
  })

  it('leaves a path through the shared name unresolved outside the packages', () => {
    const files = withFiles({
      ...VENDORED,
      [MAIN]: `extern crate shop_core as sc;\nuse ::shop_core::version;\nuse sc::version;\n${fixtureContent(MAIN)}`,
    })
    expect(
      resolutionsOf(files, MAIN, [
        'shop_core',
        '::shop_core::version',
        'sc::version',
        'shop_core::{api, store::Store as ShopStore}',
      ]),
    ).toEqual([
      unresolved('shop_core'),
      unresolved('::shop_core::version'),
      unresolved('sc::version'),
      unresolved('shop_core'),
      unresolved('shop_core::{api, store::Store as ShopStore}'),
    ])
  })

  it("resolves the name inside each package's own crates to its own library", () => {
    const files = withFiles(VENDORED)
    expect(resolutionsOf(files, SEED, ['shop_core::store::Store'])).toEqual([
      internal('shop_core::store::Store', 'shop/src/store/mod.rs'),
    ])
    expect(
      resolutionsOf(files, 'vendored/shop/src/bin/tool.rs', ['shop_core::version']),
    ).toEqual([internal('shop_core::version', 'vendored/shop/src/lib.rs')])
  })

  it('detects a collision made by a [lib] name, whatever order the manifests arrive in', () => {
    const renamed = {
      'tools/Cargo.toml': '[package]\nname = "tools"\n\n[lib]\nname = "shop_core"\n',
      'tools/src/lib.rs': 'pub fn version() {}\n',
    }
    const files = withFiles(renamed)
    const expected = {
      file: 'shop/Cargo.toml',
      line: 1,
      message:
        'Several packages build a library named shop_core (shop/Cargo.toml, tools/Cargo.toml), so a path through shop_core is unresolved outside those packages.',
    }
    for (const ordered of [files, [...files].reverse()]) {
      const scanned = scan(ordered)
      expect(
        scanned.diagnostics.filter((entry) =>
          entry.message.includes('build a library named'),
        ),
      ).toEqual([expected])
      expect(
        scanned.imports.find(
          (fact) => fact.source === MAIN && fact.specifier === 'shop_core',
        )!.resolution,
      ).toBe('unresolved')
    }
  })

  it('names every manifest when three packages collide', () => {
    const files = withFiles({
      ...VENDORED,
      'tools/Cargo.toml': '[package]\nname = "shop-core"\n',
      'tools/src/lib.rs': 'pub fn version() {}\n',
    })
    expect(scan(files).diagnostics).toContainEqual({
      ...DIAGNOSTIC,
      message:
        'Several packages build a library named shop_core (shop/Cargo.toml, tools/Cargo.toml, vendored/shop/Cargo.toml), so a path through shop_core is unresolved outside those packages.',
    })
  })

  it('does not count a package without a library as a collision', () => {
    const files = withFiles({
      'tools/Cargo.toml': '[package]\nname = "shop-core"\n',
      'tools/src/main.rs': 'fn main() {}\n',
    })
    expect(
      scan(files).diagnostics.some((entry) =>
        entry.message.includes('build a library named'),
      ),
    ).toBe(false)
    expect(resolutionsOf(files, SEED, ['shop_core::version'])).toEqual([
      internal('shop_core::version', 'shop/src/lib.rs'),
    ])
  })
})
