import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import { beforeAll, describe, expect, it } from 'vitest'
import { scanArchitecture } from '../src/main/architecture-review/analysis'
import type { ScannerSet } from '../src/main/architecture-review/language-scanner'
import { kotlinFixture, loadInstalledScanners } from './architecture-scanner-fixtures'

let scanners: ScannerSet
beforeAll(async () => {
  scanners = await loadInstalledScanners()
})

const scan = () =>
  scanArchitecture({ files: kotlinFixture(), scope: 'fixture', exclusions: [] }, scanners)
const scanFiles = (
  files: readonly { readonly path: string; readonly content: string }[],
) => scanArchitecture({ files, scope: 'fixture', exclusions: [] }, scanners)
const importsOf = (source: string) =>
  scan()
    .imports.filter((fact) => fact.source === source)
    .map(({ specifier, resolution, target, line }) => ({
      specifier,
      resolution,
      target,
      line,
    }))

describe('Kotlin scanner on web-tree-sitter', () => {
  it('claims Kotlin source and script files and extracts package, symbols and imports', () => {
    const scanner = scanners.scannerFor('app/service.kt')!.scanner
    expect(scanner.resolvesFromFacts).toBe(true)
    const facts = scanner.parse(
      'app/service.kt',
      kotlinFixture().find((file) => file.path === 'app/service.kt')!.content,
    )
    expect(facts.packageName).toBe('app.service')
    expect(facts.symbols).toEqual([{ name: 'Service', line: 9, kind: 'class' }])
    expect(facts.resolutionSymbols).toEqual(['Service'])
    const model = kotlinFixture().find((file) => file.path === 'app/model.kt')!
    expect(scanner.parse(model.path, model.content).symbols).toContainEqual({
      name: 'DEFAULT_USER',
      line: 3,
      kind: 'property',
    })
    expect(
      facts.imports.map(({ specifier, names, line }) => [specifier, names ?? null, line]),
    ).toEqual([
      ['app.model.User', null, 3],
      ['app.model.DEFAULT_USER', null, 4],
      ['app.model.createUser', null, 5],
      ['app.missing.Missing', null, 6],
      ['kotlin.collections', ['*'], 7],
    ])
    expect(scanners.scannerFor('scripts/tool.kts')!.kind).toBe('.kts')
  })

  it('resolves imports through declared packages and leaves missing packages external', () => {
    expect(importsOf('app/service.kt')).toEqual([
      {
        specifier: 'app.model.User',
        resolution: 'internal',
        target: 'app/model.kt',
        line: 3,
      },
      {
        specifier: 'app.model.DEFAULT_USER',
        resolution: 'internal',
        target: 'app/model.kt',
        line: 4,
      },
      {
        specifier: 'app.model.createUser',
        resolution: 'internal',
        target: 'app/model.kt',
        line: 5,
      },
      {
        specifier: 'app.missing.Missing',
        resolution: 'external',
        target: undefined,
        line: 6,
      },
      {
        specifier: 'kotlin.collections',
        resolution: 'external',
        target: undefined,
        line: 7,
      },
    ])
  })

  it('preserves resolved imports when blank lines shift their locations', () =>
    hegel.test((tc) => {
      const padding = tc.draw(gs.integers({ minValue: 0, maxValue: 30 }))
      const suffix = tc.draw(gs.integers({ minValue: 0, maxValue: 1000 }))
      const result = scanFiles([
        { path: 'model.kt', content: `package models\nclass Model${suffix}` },
        {
          path: 'use.kt',
          content: `${'\n'.repeat(padding)}package consumers\nimport models.Model${suffix}\nclass Consumer`,
        },
      ])
      expect(result.imports).toEqual([
        expect.objectContaining({
          source: 'use.kt',
          target: 'model.kt',
          resolution: 'internal',
          line: padding + 2,
        }),
      ])
    }))

  it('reports malformed source while preserving imports parsed around the error', () => {
    const scanner = scanners.scannerFor('app/broken.kt')!.scanner
    const facts = scanner.parse(
      'app/broken.kt',
      'package app\nimport app.model.User\nclass Broken {',
    )
    expect(facts.diagnostics.length).toBeGreaterThan(0)
    expect(facts.imports.map((entry) => entry.specifier)).toEqual(['app.model.User'])
  })

  it('resolves wildcard imports from packages and members through their enclosing declaration', () => {
    const result = scanFiles([
      {
        path: 'consumer.kt',
        content: [
          'package consumer',
          'import app.model.*',
          'import app.model.User.Nested.*',
          'import app.model.User.Nested as NestedAlias',
          'class Consumer',
        ].join('\n'),
      },
      {
        path: 'model.kt',
        content: [
          'package app.model',
          'class User {',
          '  class Nested',
          '}',
          'class Other',
        ].join('\n'),
      },
    ])
    expect(
      result.imports.map(({ specifier, resolution, target }) => ({
        specifier,
        resolution,
        target,
      })),
    ).toEqual([
      { specifier: 'app.model', resolution: 'internal', target: 'model.kt' },
      { specifier: 'app.model.User.Nested', resolution: 'internal', target: 'model.kt' },
      { specifier: 'app.model.User.Nested', resolution: 'internal', target: 'model.kt' },
    ])
  })

  it('resolves declarations beyond the display symbol limit', () => {
    const declarations = Array.from(
      { length: 501 },
      (_, index) => `class Type${index}`,
    ).join('\n')
    const result = scanFiles([
      {
        path: 'consumer.kt',
        content: 'package consumer\nimport app.model.Type500\nclass Consumer',
      },
      { path: 'model.kt', content: `package app.model\n${declarations}` },
    ])
    expect(result.imports).toEqual([
      expect.objectContaining({
        specifier: 'app.model.Type500',
        resolution: 'internal',
        target: 'model.kt',
      }),
    ])
    const model = result.modules.find(({ path }) => path === 'model.kt')!
    expect(model.symbols).toHaveLength(500)
  })
})
