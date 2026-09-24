import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { ArchitectureCapture } from '../src/shared/architecture-review'
import type { ArchitectureAnalysis } from '../src/shared/architecture-analysis'
import { analyzeCaptureTimed } from '../src/main/architecture-review/timed-analysis'
import { ModuleFactsCache } from '../src/main/architecture-review/module-facts-cache'
import { LocalHost } from '../src/main/project-host/local-host'
import { gitBlobId } from '../src/main/architecture-review/blob-id'
import { scannerSet } from '../src/main/architecture-review/language-scanner'
import { loadInstalledScanners } from './architecture-python-fixture'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-cached-analysis-'))
  directories.push(directory)
  return directory
}
const files = new LocalHost()
const openCache = (directory: string) =>
  new ModuleFactsCache({ directory, maxBytes: 1024 * 1024, files })

const source = (path: string, content: string) => ({
  path,
  content,
  object: gitBlobId(Buffer.from(content)),
})
const capture: ArchitectureCapture = {
  root: localPath('/repo'),
  baselineRef: 'HEAD',
  currentRef: 'working tree',
  baselineRevision: 'a'.repeat(40),
  currentRevision: 'working-tree',
  fingerprint: 'f',
  before: [
    source('src/a.ts', "import './b'\nexport function a() {}"),
    source('src/b.ts', 'export const b = 1'),
    source('src/view.tsx', "import { a } from './a'\nexport const v = <a />"),
  ],
  after: [
    source('src/a.ts', "import './b'\nimport './c'\nexport function a() {}"),
    source('src/b.ts', 'export const b = 1'),
    source('src/c.ts', 'export interface C {}'),
    source('src/view.tsx', "import { a } from './a'\nexport const v = <a />"),
  ],
  configs: { before: [], after: [] },
  exclusions: [],
  capturedAt: 'now',
}
let uncached: ArchitectureAnalysis
beforeAll(async () => {
  uncached = (await analyzeCaptureTimed(capture)).analysis
})

it('parses each distinct blob once and answers the next scan from disk alone', async () => {
  const directory = await cacheDirectory()
  const cold = openCache(directory)
  expect((await analyzeCaptureTimed(capture, undefined, cold)).analysis).toEqual(uncached)
  // a.ts differs between the ends; b.ts and view.tsx are shared, so five distinct blobs.
  expect(cold.stats()).toMatchObject({ hits: 0, misses: 5, entries: 5 })
  const warm = openCache(directory)
  expect((await analyzeCaptureTimed(capture, undefined, warm)).analysis).toEqual(uncached)
  expect(warm.stats()).toMatchObject({ hits: 5, misses: 0, discarded: 0 })
})

it('discards a corrupt entry, reparses that module and keeps the analysis exact', async () => {
  const directory = await cacheDirectory()
  await analyzeCaptureTimed(capture, undefined, openCache(directory))
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const view = entries.find((entry) => entry.name.endsWith('.tsx.json'))!
  const file = join(view.parentPath, view.name)
  await writeFile(file, (await readFile(file, 'utf8')).slice(0, 40))
  const reopened = openCache(directory)
  expect((await analyzeCaptureTimed(capture, undefined, reopened)).analysis).toEqual(
    uncached,
  )
  expect(reopened.stats()).toMatchObject({ hits: 4, misses: 1, discarded: 1 })
  const again = openCache(directory)
  await analyzeCaptureTimed(capture, undefined, again)
  expect(again.stats()).toMatchObject({ hits: 5, misses: 0, discarded: 0 })
})

it('caches Python facts under the Python scanner version, apart from TypeScript', async () => {
  const scanners = await loadInstalledScanners()
  const mixed: ArchitectureCapture = {
    ...capture,
    before: [
      ...capture.before,
      source('py/a.py', 'from . import b\n'),
      source('py/b.py', 'X = 1\n'),
    ],
    after: [
      ...capture.after,
      source('py/a.py', 'from . import b\n'),
      source('py/b.py', 'X = 2\n'),
    ],
  }
  const expected = (await analyzeCaptureTimed(mixed, undefined, undefined, scanners))
    .analysis
  expect(expected.after.imports).toContainEqual(
    expect.objectContaining({ source: 'py/a.py', target: 'py/b.py' }),
  )
  const directory = await cacheDirectory()
  const cold = openCache(directory)
  await analyzeCaptureTimed(mixed, undefined, cold, scanners)
  // Five TypeScript blobs as above, plus a.py and both versions of b.py.
  expect(cold.stats()).toMatchObject({ hits: 0, misses: 8, entries: 8 })
  const entries = await readdir(directory, { recursive: true })
  expect(entries.filter((name) => String(name).endsWith('.py.json'))).toHaveLength(3)
  const upgraded = scannerSet(
    scanners.scanners.map((scanner) =>
      scanner.language === 'python'
        ? { ...scanner, version: `${scanner.version}-next` }
        : scanner,
    ),
  )
  const warm = openCache(directory)
  const reparsed = await analyzeCaptureTimed(mixed, undefined, warm, upgraded)
  expect(reparsed.analysis).toEqual(expected)
  expect(warm.stats()).toMatchObject({ hits: 5, misses: 3, discarded: 0 })
})

it.skipIf(process.getuid?.() === 0)(
  'discloses an unusable cache as a diagnostic and still analyzes by parsing',
  async () => {
    const directory = await cacheDirectory()
    await chmod(directory, 0o500)
    try {
      const timed = await analyzeCaptureTimed(capture, undefined, openCache(directory))
      expect(timed.analysis.modules).toEqual(uncached.modules)
      expect(timed.analysis.imports).toEqual(uncached.imports)
      const disclosed = timed.analysis.before.diagnostics.filter(
        (diagnostic) => diagnostic.file === '(parse cache)',
      )
      expect(disclosed).toHaveLength(1)
      expect(disclosed[0]!.line).toBe(1)
      expect(disclosed[0]!.message).toMatch(
        /^Parse cache unavailable, modules were parsed: /,
      )
    } finally {
      await chmod(directory, 0o700)
    }
  },
)
