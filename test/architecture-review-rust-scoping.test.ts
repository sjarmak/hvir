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
