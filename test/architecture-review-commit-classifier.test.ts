import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ArchitectureCommitClassifier,
  type ModuleImportsPort,
  type PairScanPort,
} from '../src/main/architecture-review/commit-classifier'
import type {
  ArchitectureAnalysis,
  ArchitectureImportDelta,
} from '../src/shared/architecture-analysis'
import { readModuleEdges } from '../src/main/architecture-review/module-edges'
import {
  compareArchitecture,
  scanArchitecture,
} from '../src/main/architecture-review/analysis'
import { changeFromAnalysis } from '../src/main/architecture-review/commit-change'
import { CommitChangeCache } from '../src/main/architecture-review/commit-change-cache'
import { CommitChangeStore } from '../src/main/architecture-review/commit-change-store'
import {
  inArchitectureScope,
  isSource,
} from '../src/main/architecture-review/capture-entries'
import { TYPESCRIPT_ONLY_SCANNERS } from '../src/main/architecture-review/typescript-scanner'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'
import { ARCHITECTURE_SCOPE } from '../src/shared/architecture-review'
import { architectureBlobCache } from '../src/main/architecture-review/scan-caches'
import { captureArchitecture } from '../src/main/architecture-review/capture'
import { analyzeCaptureTimed } from '../src/main/architecture-review/timed-analysis'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
const signal = () => new AbortController().signal
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-commit-classifier-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  const commit = async (message: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), content)
    }
    git(root, 'add', '-A')
    git(root, 'commit', '--allow-empty', '-m', message)
    return git(root, 'rev-parse', 'HEAD')
  }
  return { root, commit, host: new LocalHost() }
}
const EMPTY_SIDE = {
  fingerprint: 'f',
  scope: 'src',
  exclusions: [],
  modules: [],
  imports: [],
  diagnostics: [],
}
const EMPTY_ANALYSIS: ArchitectureAnalysis = {
  before: EMPTY_SIDE,
  after: EMPTY_SIDE,
  modules: [],
  imports: [],
  relationships: [],
}
const addedImport: ArchitectureImportDelta = {
  source: 'src/a.ts',
  specifier: './b',
  form: 'import',
  kind: 'runtime',
  resolution: 'internal',
  line: 1,
  column: 1,
  change: 'added',
}
function classifier() {
  const imports = vi.fn<ModuleImportsPort>((request, root) =>
    readModuleEdges(request, root, undefined, TYPESCRIPT_ONLY_SCANNERS),
  )
  return { imports, classifier: new ArchitectureCommitClassifier({ imports }) }
}

it('classifies source and configuration edits in repositories with source links', async () => {
  const r = await repository()
  await r.commit('source', { 'src/a.ts': 'export const a = 1\n' })
  await symlink('a.ts', join(r.root, 'src/alias.ts'))
  await r.commit('link', {})
  const body = await r.commit('body', { 'src/a.ts': 'export const a = 2\n' })
  const config = await r.commit('config', { 'tsconfig.json': '{"compilerOptions":{}}' })
  const subject = new ArchitectureCommitClassifier({
    imports: classifier().imports,
    scan: async (host, request, signal) => {
      const capture = await captureArchitecture(host, request, signal)
      return (await analyzeCaptureTimed(capture)).analysis
    },
  })
  const result = await subject.classify(
    r.host,
    { root: localPath(r.root), revisions: [config, body] },
    signal(),
  )
  expect(result.classifications.map((entry) => entry.change)).toEqual(['none', 'code'])
})

it('classifies each commit against its first parent and caches the answers', async () => {
  const r = await repository()
  const added = await r.commit('add modules', {
    'src/a.ts': "import { b } from './b'\nexport const a = b\n",
    'src/b.ts': 'export const b = 1\n',
  })
  const bodyOnly = await r.commit('edit body', {
    'src/b.ts': 'export const b = 2\n',
  })
  const rewired = await r.commit('rewire', {
    'src/a.ts': "import { c } from './c'\nexport const a = c\n",
    'src/c.ts': 'export const c = 3\n',
  })
  const docs = await r.commit('docs', { 'README.md': 'hello\n' })
  const empty = await r.commit('empty', {})
  git(r.root, 'switch', '-c', 'side')
  const side = await r.commit('side', { 'src/d.ts': 'export const d = 4\n' })
  git(r.root, 'switch', 'main')
  const mainOnly = await r.commit('main body', { 'src/b.ts': 'export const b = 5\n' })
  git(r.root, 'merge', '--no-ff', '-m', 'merge side', 'side')
  const merge = git(r.root, 'rev-parse', 'HEAD')
  const { imports, classifier: subject } = classifier()
  const request = {
    root: localPath(r.root),
    revisions: [merge, mainOnly, side, empty, docs, rewired, bodyOnly, added],
  }
  const { head, classifications: result } = await subject.classify(
    r.host,
    request,
    signal(),
  )
  expect(head).toBe(merge)
  expect(result.map((entry) => [entry.revision, entry.merge, entry.change])).toEqual([
    [merge, true, 'architecture'],
    [mainOnly, false, 'code'],
    [side, false, 'architecture'],
    [empty, false, 'none'],
    [docs, false, 'none'],
    [rewired, false, 'architecture'],
    [bodyOnly, false, 'code'],
    [added, false, 'architecture'],
  ])
  expect(result[0]?.parent).toBe(mainOnly)
  expect(result[7]?.parent).toBeNull()
  expect(imports).toHaveBeenCalledTimes(1)
  const again = await subject.classify(r.host, request, signal())
  expect(again.classifications).toEqual(result)
  expect(imports).toHaveBeenCalledTimes(1)
})

it('answers commits classified in an earlier process from the store on disk', async () => {
  const r = await repository()
  const added = await r.commit('add modules', {
    'src/a.ts': "import { b } from './b'\nexport const a = b\n",
    'src/b.ts': 'export const b = 1\n',
  })
  const docs = await r.commit('docs', { 'README.md': 'hello\n' })
  const directory = await mkdtemp(join(tmpdir(), 'hvir-commit-change-store-'))
  roots.push(directory)
  const request = { root: localPath(r.root), revisions: [docs, added] }
  const store = () => new CommitChangeStore({ files: new LocalHost(), directory })
  const first = store()
  const { imports } = classifier()
  const earlier = await new ArchitectureCommitClassifier({ imports, store: first }).classify(
    r.host,
    request,
    signal(),
  )
  await first.flush()

  const unused = vi.fn<ModuleImportsPort>(() => {
    throw new Error('modules were read again')
  })
  const later = await new ArchitectureCommitClassifier({
    imports: unused,
    store: store(),
  }).classify(r.host, request, signal())
  expect(later.classifications).toEqual(earlier.classifications)
  expect(unused).not.toHaveBeenCalled()
})

it('marks a commit the fleet has classified from its note, reading no modules', async () => {
  const r = await repository()
  await r.commit('seed', { 'src/a.ts': "import { b } from './b'\nexport const a = b\n" })
  const cached = await r.commit('cache', {
    'src/b.ts': "export const b = 'redis'\n",
  })
  const testOnly = await r.commit('tests', { 'src/c.test.ts': "import './a'\n" })
  const docs = await r.commit('docs', { 'README.md': 'hello\n' })
  const plain = await r.commit('plain', { 'src/b.ts': 'export const b = 2\n' })
  const note = (revision: string, text: string) =>
    git(r.root, 'notes', '--ref=refs/notes/classification', 'add', '-m', text, revision)
  note(cached, 'Change-Type: Performance\nArchitectural: architectural\nRisk: medium')
  note(testOnly, 'Change-Type: Tests / validation\nArchitectural: none\nBead: hvir-1')
  note(docs, 'Change-Type: Documentation\nArchitectural: none')
  const { imports, classifier: subject } = classifier()
  const request = { root: localPath(r.root), revisions: [plain, docs, testOnly, cached] }
  const { classifications: result } = await subject.classify(r.host, request, signal())
  expect(result.map((entry) => [entry.change, entry.fleet])).toEqual([
    ['code', undefined],
    ['none', { type: 'Documentation', architectural: 'none', beads: [] }],
    ['code', { type: 'Tests / validation', architectural: 'none', beads: ['hvir-1'] }],
    [
      'architecture',
      { type: 'Performance', architectural: 'architectural', risk: 'medium', beads: [] },
    ],
  ])
  expect(imports).toHaveBeenCalledTimes(1)
  expect(imports.mock.calls[0]![0].sources.map((source) => source.path)).toEqual([
    'src/b.ts',
    'src/b.ts',
  ])
  git(r.root, 'notes', '--ref=refs/notes/classification', 'remove', testOnly)
  const again = await subject.classify(r.host, request, signal())
  expect(again.classifications[2]).toEqual({
    revision: testOnly,
    parent: cached,
    merge: false,
    change: 'architecture',
  })
  expect(imports).toHaveBeenCalledTimes(1)
})

it('reads modules only inside the layout scope at HEAD', async () => {
  const r = await repository()
  await r.commit('layout', {
    '.hvir/architecture.json': '{"version":1,"scope":["src/app"]}\n',
  })
  const outside = await r.commit('outside', { 'src/lib/x.ts': 'export const x = 1\n' })
  const inside = await r.commit('inside', { 'src/app/y.ts': 'export const y = 1\n' })
  const { imports, classifier: subject } = classifier()
  const { classifications: result } = await subject.classify(
    r.host,
    { root: localPath(r.root), revisions: [outside, inside] },
    signal(),
  )
  expect(result.map((entry) => entry.change)).toEqual(['none', 'architecture'])
  expect(imports).not.toHaveBeenCalled()
})

it('refuses malformed revisions, oversize requests and unknown commits', async () => {
  const r = await repository()
  const head = await r.commit('one', { 'src/a.ts': 'export {}\n' })
  const { classifier: subject } = classifier()
  const root = localPath(r.root)
  const exec = vi.spyOn(r.host, 'exec')
  await expect(
    subject.classify(r.host, { root, revisions: ['HEAD'] }, signal()),
  ).rejects.toThrow(/revision/)
  await expect(
    subject.classify(r.host, { root, revisions: [`${head}0`] }, signal()),
  ).rejects.toThrow(/revision/)
  await expect(
    subject.classify(r.host, { root, revisions: [head.toUpperCase()] }, signal()),
  ).rejects.toThrow(/revision/)
  expect(exec).not.toHaveBeenCalled()
  await expect(
    subject.classify(r.host, { root, revisions: Array(51).fill(head) }, signal()),
  ).rejects.toThrow(/at most 50/)
  await expect(
    subject.classify(r.host, { root, revisions: ['f'.repeat(40)] }, signal()),
  ).rejects.toThrow()
  await expect(
    subject.classify(r.host, { root, revisions: [] }, signal()),
  ).resolves.toEqual({ head, classifications: [] })
})

it('leaves a commit whose modules exceed the read budget unclassified', async () => {
  const r = await repository()
  await r.commit('big', { 'src/big.ts': 'export const big = 1\n' })
  const big = await r.commit('grow', {
    'src/big.ts': `export const big = "${'x'.repeat(ARCHITECTURE_SCOPE.maxFileBytes + 1)}"\n`,
  })
  const { imports, classifier: subject } = classifier()
  const { classifications: result } = await subject.classify(
    r.host,
    { root: localPath(r.root), revisions: [big] },
    signal(),
  )
  expect(result[0]?.change).toBe('unclassified')
  expect(imports).not.toHaveBeenCalled()
})

it('reconsiders a commit modifying more than two hundred modules on every request', async () => {
  const r = await repository()
  const many = (body: string) =>
    Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [
        `src/m${i}.ts`,
        `export const m = ${body}\n`,
      ]),
    )
  await r.commit('many', many('1'))
  const wide = await r.commit('touch all', many('2'))
  const { imports, classifier: subject } = classifier()
  const lookup = vi.spyOn(CommitChangeCache.prototype, 'lookup')
  const request = { root: localPath(r.root), revisions: [wide] }
  const first = await subject.classify(r.host, request, signal())
  expect(first.classifications[0]?.change).toBe('unclassified')
  const second = await subject.classify(r.host, request, signal())
  expect(second.classifications[0]?.change).toBe('unclassified')
  expect(lookup.mock.results.map((result) => result.value as unknown)).toEqual(
    lookup.mock.results.map(() => undefined),
  )
  expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(imports).not.toHaveBeenCalled()
})

it('scans a commit whose language resolves from every module facts, within the scan budget', async () => {
  const r = await repository()
  await r.commit('seed', { 'src/a.ts': "import './b'\n", 'src/b.ts': 'export {}\n' })
  const edited = await r.commit('edit', { 'src/a.ts': "import './b'\nexport {}\n" })
  const imports = vi.fn<ModuleImportsPort>((request) =>
    Promise.resolve({
      scanners: 'facts',
      edges: request.sources.map((source) => ({
        side: source.side,
        path: source.path,
        object: source.object!,
        edges: null,
        needsFacts: true,
      })),
    }),
  )
  const request = { root: localPath(r.root), revisions: [edited] }
  const { classifications: unscanned } = await new ArchitectureCommitClassifier({
    imports,
  }).classify(r.host, request, signal())
  expect(unscanned[0]?.change).toBe('unclassified')
  const scan = vi.fn<PairScanPort>(() => Promise.resolve(EMPTY_ANALYSIS))
  const scanning = new ArchitectureCommitClassifier({ imports, scan })
  const { classifications } = await scanning.classify(r.host, request, signal())
  expect(classifications[0]?.change).toBe('code')
  expect(scan.mock.calls.map(([, sent]) => [sent.baseline, sent.current])).toEqual([
    [git(r.root, 'rev-parse', `${edited}~1`), edited],
  ])
  await scanning.classify(r.host, request, signal())
  expect(scan).toHaveBeenCalledTimes(1)
})

it('lists each side once per request and passes its configs to the resolver', async () => {
  const r = await repository()
  await r.commit('seed', {
    'tsconfig.json': '{}\n',
    'src/a.ts': "import './b'\n",
    'src/b.ts': 'export {}\n',
  })
  const one = await r.commit('one', { 'src/a.ts': "import './b'\nexport {}\n" })
  const two = await r.commit('two', { 'src/b.ts': 'export const b = 1\n' })
  const { imports, classifier: subject } = classifier()
  const exec = vi.spyOn(r.host, 'exec')
  await subject.classify(
    r.host,
    { root: localPath(r.root), revisions: [two, one] },
    signal(),
  )
  const listings = exec.mock.calls.filter(
    ([, args]) => args.includes('ls-tree') && args.includes('-r'),
  )
  expect(listings).toHaveLength(3)
  expect(imports).toHaveBeenCalledTimes(1)
  const sent = imports.mock.calls[0]![0]
  expect(sent.sides.map((side) => side.revision).sort()).toEqual(
    [git(r.root, 'rev-parse', `${one}~1`), one, two].sort(),
  )
  for (const side of sent.sides) {
    expect(side.modules).toEqual(['src/a.ts', 'src/b.ts'])
    expect(side.configs.map((config) => config.path)).toEqual(['tsconfig.json'])
  }
})

it('keeps the importing module identity when two modified modules share a blob', async () => {
  const main = "import { x } from './x'\nexport const m = x\n"
  const respelled = "import { x } from './x/index'\nexport const m = x\n"
  const scanAt = (root: string, revision: string) => {
    const paths = git(root, 'ls-tree', '-r', '--name-only', revision).split('\n')
    const files = paths.filter(isSource).map((path) => ({
      path,
      content: git(root, 'show', `${revision}:${path}`),
    }))
    return scanArchitecture(
      { files, scope: '.', exclusions: [] },
      TYPESCRIPT_ONLY_SCANNERS,
    )
  }
  const classify = async (seed: Record<string, string>) => {
    const r = await repository()
    const parent = await r.commit('seed', {
      'src/a/main.ts': main,
      'src/z/main.ts': main,
      ...seed,
    })
    const edited = await r.commit('respell', {
      'src/a/main.ts': respelled,
      'src/z/main.ts': respelled,
    })
    const { classifier: subject } = classifier()
    const { classifications } = await subject.classify(
      r.host,
      { root: localPath(r.root), revisions: [edited] },
      signal(),
    )
    const scanned = changeFromAnalysis(
      compareArchitecture(scanAt(r.root, parent), scanAt(r.root, edited)),
      2,
    )
    return [classifications[0]?.change, scanned]
  }
  expect(
    await classify({
      'src/a/x.ts': 'export const x = 1\n',
      'src/a/x/index.ts': 'export const x = 2\n',
      'src/z/x/index.ts': 'export const x = 3\n',
    }),
  ).toEqual(['architecture', 'architecture'])
  expect(
    await classify({
      'src/a/x/index.ts': 'export const x = 2\n',
      'src/z/x/index.ts': 'export const x = 3\n',
    }),
  ).toEqual(['code', 'code'])
})

it('leaves a commit whose side listing overflows unclassified and uncached, and answers the rest', async () => {
  const r = await repository()
  await r.commit('seed', { 'src/a.ts': "import './b'\n", 'src/b.ts': 'export {}\n' })
  const first = await r.commit('first', { 'src/a.ts': "import './b'\nexport {}\n" })
  const second = await r.commit('second', { 'src/b.ts': 'export const b = 1\n' })
  const { classifier: subject } = classifier()
  const exec = r.host.exec.bind(r.host)
  const overflowing = vi
    .spyOn(r.host, 'exec')
    .mockImplementation((command, args, options) =>
      args.includes('ls-tree') && args.includes(second)
        ? Promise.reject(new Error('exec output exceeded maxBuffer (16777216 bytes)'))
        : exec(command, args, options),
    )
  const request = { root: localPath(r.root), revisions: [second, first] }
  const { classifications } = await subject.classify(r.host, request, signal())
  expect(classifications.map((entry) => entry.change)).toEqual(['unclassified', 'code'])
  overflowing.mockRestore()
  const lookup = vi.spyOn(CommitChangeCache.prototype, 'lookup')
  const { classifications: again } = await subject.classify(r.host, request, signal())
  expect(again.map((entry) => entry.change)).toEqual(['code', 'code'])
  const found = (revision: string) =>
    lookup.mock.calls.flatMap(([key], index) =>
      key.revision === revision ? [lookup.mock.results[index]!.value as unknown] : [],
    )
  expect(found(second)).toEqual(found(second).map(() => undefined))
  expect(found(first)).toContain('code')
  lookup.mockRestore()
})

it('propagates an abort raised while listing a side', async () => {
  const r = await repository()
  await r.commit('seed', { 'src/a.ts': 'export {}\n' })
  const edited = await r.commit('edit', { 'src/a.ts': 'export const a = 1\n' })
  const { classifier: subject } = classifier()
  const controller = new AbortController()
  const exec = r.host.exec.bind(r.host)
  vi.spyOn(r.host, 'exec').mockImplementation((command, args, options) => {
    if (args.includes('ls-tree') && args.includes('-r')) {
      controller.abort(new Error('cancelled'))
      return Promise.reject(new Error('cancelled'))
    }
    return exec(command, args, options)
  })
  await expect(
    subject.classify(
      r.host,
      { root: localPath(r.root), revisions: [edited] },
      controller.signal,
    ),
  ).rejects.toThrow('cancelled')
})

it('scans a config or layout change against its parent and caches the answer', async () => {
  const r = await repository()
  await r.commit('module', { 'src/a.ts': 'export const a = 1\n' })
  const tsconfig = await r.commit('tsconfig', {
    'tsconfig.json': '{"compilerOptions":{}}\n',
  })
  const layoutCommit = await r.commit('layout', {
    '.hvir/architecture.json': '{"version":1,"scope":["src"]}\n',
  })
  const { imports } = classifier()
  const scan = vi.fn<PairScanPort>((_host, request) =>
    Promise.resolve(
      request.current === layoutCommit
        ? { ...EMPTY_ANALYSIS, modules: [], relationships: [], imports: [addedImport] }
        : EMPTY_ANALYSIS,
    ),
  )
  const scanning = new ArchitectureCommitClassifier({ imports, scan })
  const request = { root: localPath(r.root), revisions: [layoutCommit, tsconfig] }
  const { classifications: result } = await scanning.classify(r.host, request, signal())
  expect(result.map((entry) => entry.change)).toEqual(['architecture', 'none'])
  expect(scan.mock.calls.map(([, sent]) => [sent.baseline, sent.current])).toEqual([
    [tsconfig, layoutCommit],
    [git(r.root, 'rev-parse', `${tsconfig}~1`), tsconfig],
  ])
  expect(imports).not.toHaveBeenCalled()
  await scanning.classify(r.host, request, signal())
  expect(scan).toHaveBeenCalledTimes(2)
})

it('leaves a config change unclassified when the scan refuses or is unavailable', async () => {
  const r = await repository()
  await r.commit('module', { 'src/a.ts': 'export const a = 1\n' })
  const tsconfig = await r.commit('tsconfig', { 'tsconfig.json': '{}\n' })
  const { imports, classifier: subject } = classifier()
  const request = { root: localPath(r.root), revisions: [tsconfig] }
  const change = async (classifier: ArchitectureCommitClassifier) =>
    (await classifier.classify(r.host, request, signal())).classifications[0]?.change
  expect(await change(subject)).toBe('unclassified')
  const scan = vi.fn<PairScanPort>(() => Promise.resolve(undefined))
  const refusing = new ArchitectureCommitClassifier({ imports, scan })
  expect(await change(refusing)).toBe('unclassified')
  expect(await change(refusing)).toBe('unclassified')
  expect(scan).toHaveBeenCalledTimes(2)
})

it('spends the aggregate read budget commit by commit and never fails the request', async () => {
  const r = await repository()
  const body = (n: number) => `export const s = "${String(n).repeat(1024)}"\n`
  await r.commit('seed', {
    'src/a.ts': body(1),
    'src/b.ts': body(2),
    'src/c.ts': body(3),
  })
  const first = await r.commit('a', { 'src/a.ts': body(4) })
  const second = await r.commit('b', { 'src/b.ts': body(5) })
  const third = await r.commit('c', { 'src/c.ts': body(6) })
  const { imports } = classifier()
  const subject = new ArchitectureCommitClassifier({
    imports,
    budget: { maxFileBytes: 4 * 1024, maxTotalBytes: 3 * 1024 },
  })
  const { classifications: result } = await subject.classify(
    r.host,
    { root: localPath(r.root), revisions: [third, second, first] },
    signal(),
  )
  expect(result.map((entry) => entry.change)).toEqual([
    'code',
    'unclassified',
    'unclassified',
  ])
  expect(imports).toHaveBeenCalledTimes(1)
  expect(imports.mock.calls[0]![0].sources.map((source) => source.path)).toEqual([
    'src/c.ts',
    'src/c.ts',
  ])
  const again = await subject.classify(
    r.host,
    { root: localPath(r.root), revisions: [second] },
    signal(),
  )
  expect(again.classifications[0]?.change).toBe('code')
})

it('agrees with a full pair scan on every fast path', { timeout: 30_000 }, async () => {
  const r = await repository()
  const a = "import { b } from './b'\nexport const a = b\n"
  const external =
    "import { c } from './c'\nimport { join } from 'node:path'\nexport const a = join(c)\n"
  const alias = JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/*'] } },
  })
  const pkg = JSON.stringify({
    name: 'app',
    exports: { './util': './src/x/index.ts', './other': './src/b.ts' },
  })
  const steps: readonly (readonly [string, Record<string, string>])[] = [
    [
      'add',
      {
        'src/a.ts': a,
        'src/b.ts': 'export const b = 1\n',
        'src/c.ts': 'export const c = 3\n',
      },
    ],
    ['body', { 'src/b.ts': 'export const b = 2\n' }],
    ['duplicate', { 'src/a.ts': `${a}export const again = () => import('./b')\n` }],
    [
      'type only',
      { 'src/a.ts': "import type { b } from './b'\nexport const a: typeof b = 1\n" },
    ],
    [
      'respell',
      { 'src/a.ts': "import type { b } from './b.js'\nexport const a: typeof b = 1\n" },
    ],
    ['rewire', { 'src/a.ts': "import { c } from './c'\nexport const a = c\n" }],
    ['external', { 'src/a.ts': external }],
    [
      'reorder',
      {
        'src/a.ts':
          "import { join } from 'node:path'\nimport { c } from './c'\nexport const a = join(c)\n",
      },
    ],
    ['module', { 'src/d.ts': 'export const d = 4\n' }],
    [
      'alias config',
      {
        'tsconfig.json': alias,
        'src/a.ts':
          "import { c } from '@lib/c'\nimport { join } from 'node:path'\nexport const a = join(c)\n",
      },
    ],
    ['alias respelled', { 'src/a.ts': external }],
    [
      'index twin',
      {
        'src/x.ts': 'export const x = 1\n',
        'src/x/index.ts': 'export const x = 2\n',
        'src/a.ts': "import { x } from './x'\nexport const a = x\n",
      },
    ],
    [
      'index respelled',
      { 'src/a.ts': "import { x } from './x/index'\nexport const a = x\n" },
    ],
    [
      'exports config',
      {
        'package.json': pkg,
        'src/a.ts': "import { x } from 'app/util'\nexport const a = x\n",
      },
    ],
    [
      'exports subpath',
      { 'src/a.ts': "import { b } from 'app/other'\nexport const a = b\n" },
    ],
    [
      'exports respelled',
      { 'src/a.ts': "import { b } from './b'\nexport const a = b\n" },
    ],
  ]
  const revisions: string[] = []
  for (const [message, files] of steps) revisions.push(await r.commit(message, files))
  const scanAt = (revision: string) => {
    const paths = git(r.root, 'ls-tree', '-r', '--name-only', revision).split('\n')
    const read = (path: string) => ({
      path,
      content: git(r.root, 'show', `${revision}:${path}`),
    })
    const files = paths.filter(isSource).map(read)
    const configs = paths
      .filter((path) => inArchitectureScope(path) && !isSource(path))
      .map(read)
    return scanArchitecture(
      { files, configs, scope: '.', exclusions: [] },
      TYPESCRIPT_ONLY_SCANNERS,
    )
  }
  const pairScan = (baseline: string, current: string) =>
    compareArchitecture(scanAt(baseline), scanAt(current))
  const { imports } = classifier()
  const scan = vi.fn<PairScanPort>((_host, request) =>
    Promise.resolve(pairScan(request.baseline ?? 'HEAD', request.current ?? 'HEAD')),
  )
  const subject = new ArchitectureCommitClassifier({ imports, scan })
  const { classifications } = await subject.classify(
    r.host,
    { root: localPath(r.root), revisions },
    signal(),
  )
  const expected = [
    'architecture',
    'code',
    'code',
    'code',
    'code',
    'architecture',
    'architecture',
    'code',
    'architecture',
    'code',
    'code',
    'architecture',
    'architecture',
    'code',
    'architecture',
    'code',
  ]
  expect(classifications.map((entry) => entry.change)).toEqual(expected)
  expect(scan).toHaveBeenCalledTimes(2)
  for (const [index, entry] of classifications.entries()) {
    if (entry.parent === null) continue
    const scanned = changeFromAnalysis(pairScan(entry.parent, entry.revision), 1)
    expect([revisions[index], scanned]).toEqual([revisions[index], entry.change])
  }
})

it('reads the modules it compares through a shared blob cache', async () => {
  const r = await repository()
  await r.commit('add modules', {
    'src/a.ts': "import { b } from './b'\nexport const a = b\n",
    'src/b.ts': 'export const b = 1\n',
    'src/c.ts': 'export const c = 3\n',
  })
  const rewired = await r.commit('rewire', {
    'src/a.ts': "import { c } from './c'\nexport const a = c\n",
  })
  const blobs = architectureBlobCache()
  const imports = vi.fn<ModuleImportsPort>((request, root) =>
    readModuleEdges(request, root, undefined, TYPESCRIPT_ONLY_SCANNERS),
  )
  const subject = new ArchitectureCommitClassifier({ imports, blobs })
  const { classifications } = await subject.classify(
    r.host,
    { root: localPath(r.root), revisions: [rewired] },
    signal(),
  )
  expect(classifications[0]?.change).toBe('architecture')
  const before = git(r.root, 'rev-parse', `${rewired}^:src/a.ts`)
  const after = git(r.root, 'rev-parse', `${rewired}:src/a.ts`)
  expect(blobs.lookup(before)).toBe("import { b } from './b'\nexport const a = b\n")
  expect(blobs.lookup(after)).toBe("import { c } from './c'\nexport const a = c\n")
})
