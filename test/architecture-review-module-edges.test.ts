import { expect, it } from 'vitest'
import { readModuleEdges } from '../src/main/architecture-review/module-edges'
import { TYPESCRIPT_ONLY_SCANNERS } from '../src/main/architecture-review/typescript-scanner'
import type { ScannerSet } from '../src/main/architecture-review/language-scanner'
import { gitBlobId } from '../src/main/architecture-review/blob-id'
import { localPath } from '../src/shared/host-path'

const source = (side: string, path: string, content: string) => ({
  side,
  path,
  content,
  object: gitBlobId(Buffer.from(content)),
})

it('resolves each module against its own side with the scanner resolver', async () => {
  const before = source(
    'p',
    'src/a.ts',
    "import { b } from './b'\nimport type { T } from './t'\nimport { x } from './x'\nimport fs from 'node:fs'\n",
  )
  const after = source(
    'c',
    'src/a.ts',
    "import { b } from './b'\nimport { x } from './x'\n",
  )
  const other = source('c', 'src/other.py', 'import os\n')
  const result = await readModuleEdges(
    {
      sides: [
        {
          revision: 'p',
          modules: ['src/a.ts', 'src/b.ts', 'src/t.ts', 'src/x.ts'],
          configs: [],
        },
        {
          revision: 'c',
          modules: ['src/a.ts', 'src/b.ts', 'src/x/index.ts'],
          configs: [],
        },
      ],
      sources: [before, after, other],
    },
    localPath('/repo'),
    undefined,
    TYPESCRIPT_ONLY_SCANNERS,
  )
  expect(result.scanners).toContain(TYPESCRIPT_ONLY_SCANNERS.scanners[0]!.version)
  expect(result.edges).toEqual([
    {
      side: 'p',
      object: before.object,
      edges: ['external: node:fs', 'src/b.ts', 'src/t.ts', 'src/x.ts'],
    },
    { side: 'c', object: after.object, edges: ['src/b.ts', 'src/x/index.ts'] },
    { side: 'c', object: other.object, edges: null },
  ])
})

it('resolves tsconfig aliases and package exports from the side configs', async () => {
  const tsconfig = {
    path: 'tsconfig.json',
    content: JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@core/*': ['src/core/*'] } },
    }),
  }
  const pkg = {
    path: 'package.json',
    content: JSON.stringify({ name: 'app', exports: { './util': './src/util.ts' } }),
  }
  const module = source('c', 'src/a.ts', "import '@core/thing'\nimport 'app/util'\n")
  const result = await readModuleEdges(
    {
      sides: [
        {
          revision: 'c',
          modules: ['src/a.ts', 'src/core/thing.ts', 'src/util.ts'],
          configs: [tsconfig, pkg],
        },
      ],
      sources: [module],
    },
    localPath('/repo'),
    undefined,
    TYPESCRIPT_ONLY_SCANNERS,
  )
  expect(result.edges).toEqual([
    { side: 'c', object: module.object, edges: ['src/core/thing.ts', 'src/util.ts'] },
  ])
})

it('reports a module whose language resolves from every module facts as needing facts', async () => {
  const base = TYPESCRIPT_ONLY_SCANNERS.scanners[0]!
  const scanners: ScannerSet = {
    ...TYPESCRIPT_ONLY_SCANNERS,
    scanners: [{ ...base, resolvesFromFacts: true }],
    scannerFor: (path) => {
      const match = TYPESCRIPT_ONLY_SCANNERS.scannerFor(path)
      return match
        ? { ...match, scanner: { ...match.scanner, resolvesFromFacts: true } }
        : match
    },
  }
  const module = source('c', 'src/a.ts', "import './b'\n")
  const result = await readModuleEdges(
    {
      sides: [{ revision: 'c', modules: ['src/a.ts', 'src/b.ts'], configs: [] }],
      sources: [module],
    },
    localPath('/repo'),
    undefined,
    scanners,
  )
  expect(result.edges).toEqual([
    { side: 'c', object: module.object, edges: null, needsFacts: true },
  ])
})
