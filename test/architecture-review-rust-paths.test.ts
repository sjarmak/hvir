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
