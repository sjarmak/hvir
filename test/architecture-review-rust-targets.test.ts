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

const MANIFEST = 'shop/Cargo.toml'
const PACKAGE = '[package]\nname = "shop-core"\nversion = "0.1.0"\n'

/** The fixture workspace with the shop manifest replaced and some files added. */
function withShop(
  manifest: string,
  added: Readonly<Record<string, string>> = {},
): ArchitectureSourceFile[] {
  const replaced = { [MANIFEST]: manifest, ...added }
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

/** The files no crate root reaches, among those asked about. */
const unreached = (files: readonly ArchitectureSourceFile[], among: readonly string[]) =>
  scan(files)
    .diagnostics.filter((entry) => entry.message.startsWith('No crate root reaches'))
    .map((entry) => entry.file)
    .filter((file) => among.includes(file))

const resolutions = (files: readonly ArchitectureSourceFile[], source: string) =>
  scan(files)
    .imports.filter((fact) => fact.source === source)
    .map(({ specifier, resolution, target }) => ({ specifier, resolution, target }))

const TARGETS = {
  'shop/src/main.rs': 'fn main() {}\n',
  'shop/src/bin/tool/main.rs': 'fn main() {}\n',
  'shop/examples/demo.rs': 'fn main() {}\n',
  'shop/examples/multi/main.rs': 'fn main() {}\n',
  'shop/tests/multi/main.rs': 'use shop_core::version;\n',
  'shop/benches/speed.rs': 'fn main() {}\n',
  'shop/benches/multi/main.rs': 'fn main() {}\n',
  'shop/build.rs': 'fn main() {}\n',
}
const ALL = [
  ...Object.keys(TARGETS),
  'shop/src/bin/seed.rs',
  'shop/src/lib.rs',
  'shop/tests/smoke.rs',
]

describe('Cargo target auto-discovery', () => {
  it('discovers every conventional target of a package by default', () => {
    expect(unreached(withShop(`${PACKAGE}edition = "2021"\n`, TARGETS), ALL)).toEqual([])
  })

  it('discovers no target of a kind whose auto flag is false', () => {
    const files = withShop(
      `${PACKAGE}edition = "2021"\nautobins = false\nautoexamples = false\nautotests = false\nautobenches = false\n`,
      TARGETS,
    )
    expect(unreached(files, ALL).sort()).toEqual(
      [
        'shop/benches/multi/main.rs',
        'shop/benches/speed.rs',
        'shop/examples/demo.rs',
        'shop/examples/multi/main.rs',
        'shop/src/bin/seed.rs',
        'shop/src/bin/tool/main.rs',
        'shop/src/main.rs',
        'shop/tests/multi/main.rs',
        'shop/tests/smoke.rs',
      ].sort(),
    )
  })

  it('makes the modules of an explicit [[test]] root children of it, not crates', () => {
    const files = withShop(
      `${PACKAGE}edition = "2021"\nautotests = false\n\n[[test]]\nname = "integration"\npath = "tests/lib.rs"\n`,
      {
        'shop/tests/lib.rs': 'mod helper;\nfn setup() {}\n',
        'shop/tests/helper.rs': 'use super::*;\nuse super::setup;\n',
      },
    )
    expect(resolutions(files, 'shop/tests/helper.rs')).toEqual([
      { specifier: 'super::*', resolution: 'internal', target: 'shop/tests/lib.rs' },
      { specifier: 'super::setup', resolution: 'internal', target: 'shop/tests/lib.rs' },
    ])
    expect(unreached(files, ['shop/tests/smoke.rs', 'shop/tests/helper.rs'])).toEqual([
      'shop/tests/smoke.rs',
    ])
  })

  it('finds an explicit target without a path by its name among the conventional files', () => {
    const files = withShop(
      `${PACKAGE}edition = "2021"\nautobins = false\n\n[[bin]]\nname = "seed"\n\n[[bin]]\nname = "shop-core"\n`,
      TARGETS,
    )
    expect(
      unreached(files, [
        'shop/src/bin/seed.rs',
        'shop/src/main.rs',
        'shop/src/bin/tool/main.rs',
      ]),
    ).toEqual(['shop/src/bin/tool/main.rs'])
  })

  it('reaches an explicit target path outside the conventional directories', () => {
    const files = withShop(
      `${PACKAGE}edition = "2021"\n\n[[example]]\nname = "show"\npath = "demos/show.rs"\n\n[[bench]]\nname = "load"\npath = "./perf/load.rs"\n`,
      { 'shop/demos/show.rs': 'fn main() {}\n', 'shop/perf/load.rs': 'fn main() {}\n' },
    )
    expect(unreached(files, ['shop/demos/show.rs', 'shop/perf/load.rs'])).toEqual([])
  })

  it('does not discover a conventional target whose name an explicit target takes', () => {
    const files = withShop(
      `${PACKAGE}edition = "2021"\n\n[[bin]]\nname = "seed"\npath = "src/tools/seed.rs"\n`,
      { 'shop/src/tools/seed.rs': 'fn main() {}\n' },
    )
    expect(unreached(files, ['shop/src/bin/seed.rs', 'shop/src/tools/seed.rs'])).toEqual([
      'shop/src/bin/seed.rs',
    ])
  })

  it('stops discovery of a kind with explicit targets in the 2015 edition only', () => {
    const tail = '\n[[test]]\nname = "integration"\npath = "tests/lib.rs"\n'
    const added = { 'shop/tests/lib.rs': '' }
    const among = ['shop/tests/smoke.rs', 'shop/tests/lib.rs', 'shop/src/bin/seed.rs']
    expect(unreached(withShop(`${PACKAGE}${tail}`, added), among)).toEqual([
      'shop/tests/smoke.rs',
    ])
    expect(
      unreached(withShop(`${PACKAGE}edition = "2015"\n${tail}`, added), among),
    ).toEqual(['shop/tests/smoke.rs'])
    expect(
      unreached(withShop(`${PACKAGE}edition = "2018"\n${tail}`, added), among),
    ).toEqual([])
    expect(
      unreached(withShop(`${PACKAGE}autotests = true\n${tail}`, added), among),
    ).toEqual([])
  })

  it('honours a build script path and build = false', () => {
    const custom = withShop(`${PACKAGE}edition = "2021"\nbuild = "tools/gen.rs"\n`, {
      'shop/build.rs': 'fn main() {}\n',
      'shop/tools/gen.rs': 'fn main() {}\n',
    })
    expect(unreached(custom, ['shop/build.rs', 'shop/tools/gen.rs'])).toEqual([
      'shop/build.rs',
    ])
    const none = withShop(`${PACKAGE}edition = "2021"\nbuild = false\n`, {
      'shop/build.rs': 'fn main() {}\n',
    })
    expect(unreached(none, ['shop/build.rs'])).toEqual(['shop/build.rs'])
  })

  it('builds no library when autolib is false and no [lib] is declared', () => {
    const files = withShop(`${PACKAGE}edition = "2021"\nautolib = false\n`)
    expect(resolutions(files, 'cli/src/main.rs')[0]).toEqual({
      specifier: 'shop_core',
      resolution: 'external',
      target: undefined,
    })
    const declared = withShop(
      `${PACKAGE}edition = "2021"\nautolib = false\n\n[lib]\nname = "shop_core"\n`,
    )
    expect(resolutions(declared, 'cli/src/main.rs')[0]).toEqual({
      specifier: 'shop_core',
      resolution: 'internal',
      target: 'shop/src/lib.rs',
    })
  })
})
