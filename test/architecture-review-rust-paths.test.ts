import { beforeAll, describe, expect, it } from 'vitest'
import type { ArchitectureSourceFile } from '../src/shared/architecture-analysis'
import { scanArchitecture } from '../src/main/architecture-review/analysis'
import { isSource } from '../src/main/architecture-review/capture-entries'
import type { ScannerSet } from '../src/main/architecture-review/language-scanner'
import { loadInstalledScanners, rustFixture } from './architecture-scanner-fixtures'

let scanners: ScannerSet
beforeAll(async () => {
  scanners = await loadInstalledScanners()
})

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

const resolutions = (files: readonly ArchitectureSourceFile[], source: string) =>
  scan(files)
    .imports.filter((fact) => fact.source === source)
    .map(({ specifier, resolution, target }) => ({ specifier, resolution, target }))

const PROBE = 'shop/src/util/fmt.rs'

describe('Rust use paths that end at an item', () => {
  it('leaves a path whose last segment names no item of the module unresolved', () => {
    const files = withFiles({
      [PROBE]: [
        'use crate::missing_item;',
        'use crate::api::missing;',
        'use crate::version;',
        'use crate::api::NAME;',
        'use crate::missing_item::{self};',
      ].join('\n'),
    })
    expect(resolutions(files, PROBE)).toEqual([
      { specifier: 'crate::missing_item', resolution: 'unresolved', target: undefined },
      { specifier: 'crate::api::missing', resolution: 'unresolved', target: undefined },
      { specifier: 'crate::version', resolution: 'internal', target: 'shop/src/lib.rs' },
      {
        specifier: 'crate::api::NAME',
        resolution: 'internal',
        target: 'shop/src/api.rs',
      },
      {
        specifier: 'crate::missing_item::{self}',
        resolution: 'unresolved',
        target: undefined,
      },
    ])
  })

  it('counts use bindings, aliases, extern crates and globs as names a module provides', () => {
    const lib = rustFixture().find((file) => file.path === 'shop/src/lib.rs')!.content
    const files = withFiles({
      'shop/src/lib.rs': [
        lib,
        'pub use crate::store::Store as Shelf;',
        'use std::collections::HashMap;',
        'extern crate serde;',
        'pub use crate::api::{self as endpoints};',
      ].join('\n'),
      'shop/src/api.rs': 'pub use crate::errors::*;\npub const NAME: &str = "api";\n',
      [PROBE]: [
        'use crate::Shelf;',
        'use crate::HashMap;',
        'use crate::serde;',
        'use crate::endpoints;',
        'use crate::api::Error;',
        'use crate::ShopStore;',
      ].join('\n'),
    })
    expect(resolutions(files, PROBE).map((entry) => entry.resolution)).toEqual([
      'internal',
      'internal',
      'internal',
      'internal',
      'internal',
      'unresolved',
    ])
  })

  it('treats a package with an empty name as unnamed', () => {
    const files = withFiles({
      'shop/Cargo.toml': '[package]\nname = ""\nversion = "0.1.0"\n',
      [PROBE]: 'use crate::x;\n',
    })
    expect(resolutions(files, PROBE)).toEqual([
      { specifier: 'crate::x', resolution: 'unresolved', target: undefined },
    ])
    expect(scan(files).diagnostics).toContainEqual({
      file: 'shop/Cargo.toml',
      line: 1,
      message: 'This Cargo.toml [package] has no name, so its crate is not resolved.',
    })
  })
})

describe('Cargo manifest tables', () => {
  const manifest = (tail: string) =>
    withFiles({
      'shop/Cargo.toml': `[package]\nname = "shop-core"\n\n[lib]\npath = "src/lib.rs"\n\n${tail}`,
    })

  it('does not read a key under a quoted-key table header as [lib] or [[bin]]', () => {
    const files = manifest(
      [
        "[target.'cfg(unix)'.dependencies.nix]",
        'path = "vendor/nix"',
        '[[bin]]',
        'path = "src/bin/seed.rs"',
        '[target."cfg(windows)".dependencies]',
        'path = "src/orphan.rs"',
      ].join('\n'),
    )
    expect(resolutions(files, 'cli/src/main.rs')[0]).toEqual({
      specifier: 'shop_core',
      resolution: 'internal',
      target: 'shop/src/lib.rs',
    })
    expect(scan(files).diagnostics.map((entry) => entry.file)).toContain(
      'shop/src/orphan.rs',
    )
    expect(scan(files).diagnostics.map((entry) => entry.file)).not.toContain(
      'shop/src/lib.rs',
    )
  })

  it('reads [lib] written with a quoted key and spaced dotted headers', () => {
    const files = withFiles({
      'shop/Cargo.toml':
        '[ "lib" ]\nname = "shop"\n[ package ]\nname = "shop-core"\n[ dependencies . serde ]\nversion = "1"\n',
      'cli/src/main.rs': 'use shop::store::Store;\n',
    })
    expect(resolutions(files, 'cli/src/main.rs')).toEqual([
      {
        specifier: 'shop::store::Store',
        resolution: 'internal',
        target: 'shop/src/store/mod.rs',
      },
    ])
  })
})

describe('Rust use bindings that name nothing', () => {
  const lib = () => rustFixture().find((file) => file.path === 'shop/src/lib.rs')!.content
  const api = () => rustFixture().find((file) => file.path === 'shop/src/api.rs')!.content
  const store = () =>
    rustFixture().find((file) => file.path === 'shop/src/store/mod.rs')!.content
  const named = (
    files: readonly ArchitectureSourceFile[],
    source: string,
    specs: string[],
  ) => resolutions(files, source).filter((entry) => specs.includes(entry.specifier))

  it('does not let a use count as the item it imports', () => {
    const files = withFiles({
      'shop/src/lib.rs': `${lib()}\nuse self::nothing;\nuse crate::nothing2;\n`,
      'shop/src/api.rs': `${api()}\nuse self::ghost;\n`,
    })
    expect(named(files, 'shop/src/lib.rs', ['self::nothing', 'crate::nothing2'])).toEqual(
      [
        { specifier: 'self::nothing', resolution: 'unresolved', target: undefined },
        { specifier: 'crate::nothing2', resolution: 'unresolved', target: undefined },
      ],
    )
    expect(named(files, 'shop/src/api.rs', ['self::ghost'])).toEqual([
      { specifier: 'self::ghost', resolution: 'unresolved', target: undefined },
    ])
  })

  it('binds a name through a glob only when the glob module provides it', () => {
    const v1 = rustFixture().find((file) => file.path === 'shop/src/api/v1.rs')!.content
    const files = withFiles({
      'shop/src/api/v1.rs': `${v1}\nuse self::nothing;\nuse self::lookup;\n`,
    })
    expect(named(files, 'shop/src/api/v1.rs', ['self::nothing', 'self::lookup'])).toEqual(
      [
        { specifier: 'self::nothing', resolution: 'unresolved', target: undefined },
        {
          specifier: 'self::lookup',
          resolution: 'internal',
          target: 'shop/src/api/v1.rs',
        },
      ],
    )
  })

  it('leaves two re-exports that name each other unresolved instead of a cycle', () => {
    const files = withFiles({
      'shop/src/api.rs': `${api()}\npub use crate::store::Phantom;\n`,
      'shop/src/store/mod.rs': `${store()}\npub use crate::api::Phantom;\n`,
    })
    expect(named(files, 'shop/src/api.rs', ['crate::store::Phantom'])).toEqual([
      { specifier: 'crate::store::Phantom', resolution: 'unresolved', target: undefined },
    ])
    expect(named(files, 'shop/src/store/mod.rs', ['crate::api::Phantom'])).toEqual([
      { specifier: 'crate::api::Phantom', resolution: 'unresolved', target: undefined },
    ])
  })

  it('still follows a chain of re-exports that ends at a declared item', () => {
    const files = withFiles({
      'shop/src/api.rs': `${api()}\npub use crate::Store as Item;\n`,
      [PROBE]: 'use crate::api::Item;\n',
    })
    expect(resolutions(files, PROBE)).toEqual([
      {
        specifier: 'crate::api::Item',
        resolution: 'internal',
        target: 'shop/src/api.rs',
      },
    ])
  })

  it('leaves a path through a declared module whose file is missing unresolved', () => {
    const files = withFiles({ 'shop/src/lib.rs': `${lib()}\nuse missing::X;\n` })
    expect(named(files, 'shop/src/lib.rs', ['missing::X'])).toEqual([
      { specifier: 'missing::X', resolution: 'unresolved', target: undefined },
    ])
  })
})

describe('Rust #[path] attributes', () => {
  const commented = () =>
    rustFixture()
      .find((file) => file.path === 'shop/src/lib.rs')!
      .content.replace(
        '#[path = "generated/codes.rs"]\n',
        '#[path = "generated/codes.rs"]\n/// Generated codes.\n// plain comment\n/* block */\n',
      )

  it('keeps a #[path] separated from its mod by doc and plain comments', () => {
    const files = withFiles({ 'shop/src/lib.rs': commented() })
    expect(resolutions(files, 'shop/src/lib.rs')).toContainEqual({
      specifier: 'codes',
      resolution: 'internal',
      target: 'shop/src/generated/codes.rs',
    })
    expect(scan(files).diagnostics.map((entry) => entry.file)).not.toContain(
      'shop/src/generated/codes.rs',
    )
  })

  it('prefers the #[path] file over a same-named sibling file', () => {
    const files = withFiles({
      'shop/src/lib.rs': commented(),
      'shop/src/codes.rs': 'pub const X: u8 = 1;\n',
    })
    expect(resolutions(files, 'shop/src/lib.rs')).toContainEqual({
      specifier: 'codes',
      resolution: 'internal',
      target: 'shop/src/generated/codes.rs',
    })
  })
})

describe('Rust files loaded through #[path]', () => {
  const lib = () => rustFixture().find((file) => file.path === 'shop/src/lib.rs')!.content
  const codes = 'pub const NOT_FOUND: u16 = 404;\npub mod inner;\n'

  it('looks for their child modules beside them, as rustc does for a mod-rs file', () => {
    const files = withFiles({
      'shop/src/lib.rs': `${lib()}\npub use codes::inner::X;\n`,
      'shop/src/generated/codes.rs': codes,
      'shop/src/generated/inner.rs': 'pub struct X;\n',
    })
    expect(resolutions(files, 'shop/src/generated/codes.rs')).toEqual([
      {
        specifier: 'inner',
        resolution: 'internal',
        target: 'shop/src/generated/inner.rs',
      },
    ])
    expect(resolutions(files, 'shop/src/lib.rs')).toContainEqual({
      specifier: 'codes::inner::X',
      resolution: 'internal',
      target: 'shop/src/generated/inner.rs',
    })
    expect(scan(files).diagnostics.map((entry) => entry.file)).not.toContain(
      'shop/src/generated/inner.rs',
    )
  })

  it('does not look in a directory named after the #[path] file', () => {
    const files = withFiles({
      'shop/src/generated/codes.rs': codes,
      'shop/src/generated/codes/inner.rs': 'pub struct X;\n',
    })
    expect(resolutions(files, 'shop/src/generated/codes.rs')).toEqual([
      { specifier: 'inner', resolution: 'unresolved', target: undefined },
    ])
  })
})

describe('Rust paths through inline modules', () => {
  const lib = () => rustFixture().find((file) => file.path === 'shop/src/lib.rs')!.content
  const inline = [
    'pub mod outer {',
    '    pub mod nested { pub fn f() {} }',
    '    pub use crate::store::Store as Shelf;',
    '    use nested::f as g;',
    '}',
  ].join('\n')

  it('leaves a path naming no item of an inline module unresolved', () => {
    const files = withFiles({
      'shop/src/lib.rs': `${lib()}\n${inline}\n`,
      [PROBE]: [
        'use crate::errors::Nope;',
        'use crate::errors::deep::Nope2;',
        'use crate::errors::Error;',
        'use crate::outer::nested::f;',
        'use crate::outer::nested::missing;',
        'use crate::outer::Shelf;',
        'use crate::outer::Missing;',
      ].join('\n'),
    })
    const at = (resolution: string, target?: string) => ({ resolution, target })
    expect(
      resolutions(files, PROBE).map(({ resolution, target }) => at(resolution, target)),
    ).toEqual([
      at('unresolved'),
      at('unresolved'),
      at('internal', 'shop/src/lib.rs'),
      at('internal', 'shop/src/lib.rs'),
      at('unresolved'),
      at('internal', 'shop/src/lib.rs'),
      at('unresolved'),
    ])
  })

  it('resolves a use inside an inline module relative to that module', () => {
    const files = withFiles({ 'shop/src/lib.rs': `${lib()}\n${inline}\n` })
    expect(resolutions(files, 'shop/src/lib.rs')).toContainEqual({
      specifier: 'nested::f as g',
      resolution: 'internal',
      target: 'shop/src/lib.rs',
    })
  })
})
