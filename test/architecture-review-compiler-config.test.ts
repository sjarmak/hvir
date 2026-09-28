import { describe, expect, it } from 'vitest'
import { scanArchitecture } from '../src/main/architecture-review/analysis'
import { gitBlobId } from '../src/main/architecture-review/blob-id'

const entries = (files: Record<string, string>) =>
  Object.entries(files).map(([path, content]) => ({ path, content }))
const scan = (sources: Record<string, string>, configs?: Record<string, unknown>) =>
  scanArchitecture({
    files: entries(sources),
    ...(configs
      ? {
          configs: entries(
            Object.fromEntries(
              Object.entries(configs).map(([path, json]) => [path, JSON.stringify(json)]),
            ),
          ),
        }
      : {}),
    scope: 'src/',
    exclusions: [],
  })
const resolved = (result: ReturnType<typeof scan>) =>
  result.imports.map((fact) => [
    fact.source,
    fact.specifier,
    fact.resolution,
    fact.target,
  ])

describe('captured compiler configuration', () => {
  it('resolves path aliases declared through an extended tsconfig', () => {
    const result = scan(
      { 'src/a.ts': "import { b } from '@app/b'", 'src/b.ts': 'export const b = 1' },
      {
        'tsconfig.base.json': {
          compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
        },
        'tsconfig.json': { extends: './tsconfig.base.json', include: ['src'] },
      },
    )
    expect(resolved(result)).toEqual([['src/a.ts', '@app/b', 'internal', 'src/b.ts']])
    expect(result.diagnostics).toEqual([])
  })

  it('applies each referenced project to the files it includes', () => {
    const result = scan(
      {
        'web/a.ts': "import '@ui/x'",
        'web/ui/x.ts': '',
        'node/a.ts': "import '@ui/x'",
        'node/fake/x.ts': '',
      },
      {
        'tsconfig.json': {
          files: [],
          references: [{ path: './tsconfig.web.json' }, { path: './tsconfig.node.json' }],
        },
        'tsconfig.web.json': {
          include: ['web/**/*'],
          compilerOptions: {
            moduleResolution: 'bundler',
            module: 'esnext',
            paths: { '@ui/*': ['./web/ui/*'] },
          },
        },
        'tsconfig.node.json': {
          include: ['node/**/*'],
          compilerOptions: {
            moduleResolution: 'bundler',
            module: 'esnext',
            paths: { '@ui/*': ['./node/fake/*'] },
          },
        },
      },
    )
    expect(resolved(result)).toEqual([
      ['node/a.ts', '@ui/x', 'internal', 'node/fake/x.ts'],
      ['web/a.ts', '@ui/x', 'internal', 'web/ui/x.ts'],
    ])
    expect(result.diagnostics).toEqual([])
  })

  it('applies a nested package tsconfig relative to its own directory', () => {
    const result = scan(
      {
        'packages/p/src/a.ts': "import '~/b'",
        'packages/p/src/b.ts': '',
      },
      {
        'packages/p/tsconfig.json': {
          compilerOptions: {
            module: 'esnext',
            moduleResolution: 'bundler',
            paths: { '~/*': ['./src/*'] },
          },
        },
      },
    )
    expect(resolved(result)).toEqual([
      ['packages/p/src/a.ts', '~/b', 'internal', 'packages/p/src/b.ts'],
    ])
  })

  it('resolves package imports through a captured package.json', () => {
    const result = scan(
      { 'src/a.ts': "import '#lib/x'", 'src/lib/x.ts': '' },
      {
        'package.json': {
          name: 'fixture',
          type: 'module',
          imports: { '#lib/*': './src/lib/*.js' },
        },
        'tsconfig.json': {
          compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' },
        },
      },
    )
    expect(resolved(result)).toEqual([['src/a.ts', '#lib/x', 'internal', 'src/lib/x.ts']])
  })

  it('resolves first-party workspace packages from captured package manifests', () => {
    const result = scan(
      {
        'apps/web/src/a.ts':
          "import { value } from '@exploreomni/types'; import { Card } from '@exploreomni/ui/specs/card'",
        'packages/types/src/index.ts': 'export const value = 1',
        'packages/ui/specs/card.tsx': 'export const Card = 1',
      },
      {
        'packages/types/package.json': {
          name: '@exploreomni/types',
          exports: { '.': './src/index.ts' },
        },
        'packages/ui/package.json': {
          name: '@exploreomni/ui',
          exports: { '.': './src/index.ts', './specs/*': './specs/*.tsx' },
        },
        'tsconfig.json': { compilerOptions: { moduleResolution: 'bundler' } },
      },
    )
    expect(resolved(result)).toEqual([
      [
        'apps/web/src/a.ts',
        '@exploreomni/types',
        'internal',
        'packages/types/src/index.ts',
      ],
      [
        'apps/web/src/a.ts',
        '@exploreomni/ui/specs/card',
        'internal',
        'packages/ui/specs/card.tsx',
      ],
    ])
  })

  it('keeps unrepresented bare packages external', () => {
    const result = scan(
      { 'src/a.ts': "import React from 'react'" },
      { 'package.json': { name: 'fixture', dependencies: { react: '^19' } } },
    )
    expect(resolved(result)).toEqual([['src/a.ts', 'react', 'external', undefined]])
  })

  it('keeps exports blocked subpaths unresolved', () => {
    const result = scan(
      {
        'src/a.ts': "import '@exploreomni/types/private'",
        'packages/types/src/index.ts': '',
        'packages/types/private.ts': '',
      },
      {
        'packages/types/package.json': {
          name: '@exploreomni/types',
          exports: { '.': './src/index.ts' },
        },
      },
    )
    expect(resolved(result)).toEqual([
      ['src/a.ts', '@exploreomni/types/private', 'unresolved', undefined],
    ])
  })

  it('follows TypeScript package main resolution without a leading dot slash', () => {
    const result = scan(
      {
        'src/a.ts': "import value from '@exploreomni/types'",
        'packages/types/src/index.ts': 'export default 1',
      },
      {
        'packages/types/package.json': {
          name: '@exploreomni/types',
          main: 'src/index.ts',
        },
      },
    )
    expect(resolved(result)).toEqual([
      ['src/a.ts', '@exploreomni/types', 'internal', 'packages/types/src/index.ts'],
    ])
  })

  it('resolves a root workspace package from its captured manifest', () => {
    const result = scan(
      { 'src/a.ts': "import value from 'fixture'", 'src/index.ts': 'export default 1' },
      { 'package.json': { name: 'fixture', exports: { '.': './src/index.ts' } } },
    )
    expect(resolved(result)).toEqual([
      ['src/a.ts', 'fixture', 'internal', 'src/index.ts'],
    ])
  })

  it('leaves duplicate workspace package names unresolved', () => {
    const result = scan(
      { 'src/a.ts': "import 'fixture'", 'one/index.ts': '', 'two/index.ts': '' },
      {
        'one/package.json': { name: 'fixture', main: 'index.ts' },
        'two/package.json': { name: 'fixture', main: 'index.ts' },
      },
    )
    expect(resolved(result)).toEqual([['src/a.ts', 'fixture', 'unresolved', undefined]])
  })

  it('does not virtualize malformed workspace package names', () => {
    const result = scan(
      { 'src/a.ts': "import 'foo/../bar'", 'bar/index.ts': '' },
      { 'packages/bar/package.json': { name: 'foo/../bar', main: 'index.ts' } },
    )
    expect(resolved(result)).toEqual([['src/a.ts', 'foo/../bar', 'external', undefined]])
  })

  it('reports a config it cannot follow and still scans with what it read', () => {
    const result = scan(
      { 'src/a.ts': "import './b'", 'src/b.ts': '' },
      { 'tsconfig.json': { extends: '@tsconfig/node20/tsconfig.json' } },
    )
    expect(resolved(result)).toEqual([['src/a.ts', './b', 'internal', 'src/b.ts']])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.file).toBe('tsconfig.json')
    expect(result.diagnostics[0]?.message).toContain('@tsconfig/node20/tsconfig.json')
  })

  it('reports malformed config text and survives reference cycles', () => {
    const malformed = scanArchitecture({
      files: [{ path: 'src/a.ts', content: '' }],
      configs: [{ path: 'tsconfig.json', content: '{ "compilerOptions": ' }],
      scope: 'src/',
      exclusions: [],
    })
    expect(malformed.diagnostics).toContainEqual(
      expect.objectContaining({ file: 'tsconfig.json', message: "'}' expected." }),
    )
    expect(malformed.diagnostics.every((entry) => entry.file === 'tsconfig.json')).toBe(
      true,
    )
    const cyclic = scan(
      { 'lib/a.ts': "import '@x/b'", 'lib/b.ts': '' },
      {
        'tsconfig.json': { files: [], references: [{ path: './tsconfig.lib.json' }] },
        'tsconfig.lib.json': {
          files: [],
          references: [{ path: './tsconfig.json' }],
        },
      },
    )
    expect(resolved(cyclic)).toEqual([['lib/a.ts', '@x/b', 'external', undefined]])
  })

  it('discloses sources that no captured config governs', () => {
    const result = scan(
      { 'other/a.ts': '', 'packages/p/a.ts': '' },
      { 'packages/p/tsconfig.json': {} },
    )
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.file).toBe('(capture)')
    expect(result.diagnostics[0]?.message).toContain('1 source file')
  })

  it('hashes modules by blob id and fingerprints configs without whole-text digests', () => {
    const sources = { 'src/a.ts': 'export const a = 1\n' }
    const plain = scan(sources, { 'tsconfig.json': {} })
    expect(plain.modules[0]?.hash).toBe(gitBlobId(Buffer.from(sources['src/a.ts'])))
    const pinned = scanArchitecture({
      files: [{ path: 'src/a.ts', content: sources['src/a.ts'], object: 'f'.repeat(40) }],
      scope: 'src/',
      exclusions: [],
    })
    expect(pinned.modules[0]?.hash).toBe('f'.repeat(40))
    const strict = scan(sources, {
      'tsconfig.json': { compilerOptions: { strict: true } },
    })
    expect(strict.fingerprint).not.toBe(plain.fingerprint)
    expect(scan(sources, { 'tsconfig.json': {} }).fingerprint).toBe(plain.fingerprint)
  })
})
