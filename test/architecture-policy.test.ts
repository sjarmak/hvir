import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  evaluateInventory,
  isRelaxation,
  physicalLines,
  toolOwnedDirectory,
  validatePolicy,
} from '../scripts/architecture-policy.mts'
import {
  collectInventory,
  createArchitectureInventory,
  validateGeneratedOwnership,
} from '../scripts/architecture-inventory.mts'
import { formatReport } from '../scripts/architecture-hotspots.mts'
import { budget, ordinaryPolicy, repository } from './fixtures/architecture/repository.ts'

const fixtures: ReturnType<typeof repository>[] = []
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})
function repo() {
  const r = repository()
  fixtures.push(r)
  return r
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose()
})

describe('complete architecture budget policy', () => {
  it('disposes inventory caches between evaluations and never prefetches historical data bodies', () => {
    const r = repo(),
      policy = ordinaryPolicy()
    r.source(10)
    r.write('build/asset.png', 'binary fixture')
    const head = r.commit()
    const asset = r.git('rev-parse', `${head}:build/asset.png`)
    const count = () =>
      vi
        .mocked(execFileSync)
        .mock.calls.filter((call) => Array.isArray(call[1]) && call[1][0] === 'cat-file')
        .length
    const before = count(),
      first = createArchitectureInventory(r.root)
    first.collectInventory(policy, head)
    first.collectInventory(policy, head)
    expect(count() - before).toBe(1)
    createArchitectureInventory(r.root).collectInventory(policy, head)
    expect(count() - before).toBe(2)
    for (const call of vi.mocked(execFileSync).mock.calls) {
      if (Array.isArray(call[1]) && call[1][0] === 'cat-file') {
        const input = call[2]?.input
        if (typeof input !== 'string')
          throw new Error('Expected textual Git object selectors')
        expect(input).not.toContain(asset)
      }
    }
  })
  it('gives local artifacts narrow dispositions without hiding maintained or executable source', () => {
    const r = repo(),
      policy = ordinaryPolicy()
    for (const path of [
      'build.log',
      'tsconfig.tsbuildinfo',
      '.env.local',
      '.beads.gate.lock',
    ])
      r.write(path, 'local artifact')
    r.write('.gitignore', 'src/ignored.ts\n')
    r.source(1001, 'src/ignored.ts')
    r.write('scripts/hook.log', '#!/bin/sh\necho check\n')
    chmodSync(join(r.root, 'scripts/hook.log'), 0o755)
    const files = collectInventory(r.root, policy)
    expect([...files.keys()]).toEqual(['scripts/hook.log', 'src/ignored.ts'])
    const head = r.commit()
    expect([...collectInventory(r.root, policy, head).keys()]).toEqual([
      'scripts/hook.log',
    ])
    r.write('scripts/unknown.py', 'print(1)')
    expect(() => collectInventory(r.root, policy)).toThrow(/Unclassified source language/)
    r.remove('scripts/unknown.py')
    policy.extensions.push('.log')
    expect(collectInventory(r.root, policy).has('build.log')).toBe(true)
  })
  it('treats a go.mod as a build manifest, not an unclassified source language', () => {
    const r = repo(),
      policy = ordinaryPolicy()
    r.write('go.mod', 'module example.com/app\n')
    r.write('tools/go.mod', 'module example.com/tools\n')
    r.source(1, 'src/owner.ts')
    expect([...collectInventory(r.root, policy).keys()]).toEqual(['src/owner.ts'])
  })
  it('keeps a tool-owned directory outside the inventory whether tracked, executable, or runtime', () => {
    const r = repo(),
      policy = ordinaryPolicy()
    r.write(
      '.beads/hooks/pre-commit',
      '#!/usr/bin/env sh\nbd hooks run pre-commit "$@"\n',
    )
    chmodSync(join(r.root, '.beads/hooks/pre-commit'), 0o755)
    r.write('.beads/issues.jsonl', '{"id":"hvir-1"}\n')
    r.write('.beads/config.yaml', 'sync: false\n')
    r.source(1, 'src/.beads/nested.ts')
    r.source(1, 'src/owner.ts')
    const head = r.commit()
    r.write('.beads/backup/state.darc', 'opaque archive')
    r.write('.beads/dolt-server.pid', '4242\n')
    r.write('.beads/embeddeddolt/hvir/.dolt/noms/manifest', 'noms')
    r.write('.gc/runtime/x.pid', '4242\n')
    r.write('.gc/scripts/x.sh', '#!/usr/bin/env sh\necho seat\n')
    chmodSync(join(r.root, '.gc/scripts/x.sh'), 0o755)
    const expected = ['src/.beads/nested.ts', 'src/owner.ts']
    expect([...collectInventory(r.root, policy).keys()].sort()).toEqual(expected)
    expect([...collectInventory(r.root, policy, head).keys()].sort()).toEqual(expected)
    expect(toolOwnedDirectory('.beads')).toBe(true)
    expect(toolOwnedDirectory('.beads/hooks/pre-commit')).toBe(true)
    expect(toolOwnedDirectory('.gc/runtime/packs/dolt/dolt.pid')).toBe(true)
    for (const path of [
      '.beadsx/hooks/pre-commit',
      'beads/x.ts',
      'src/.beads/nested.ts',
      'src/.gc/nested.ts',
    ])
      expect(toolOwnedDirectory(path)).toBe(false)
  })
  it.each([
    [500, false, 'ok'],
    [501, true, 'ok'],
    [1000, true, 'ok'],
    [1001, true, 'over'],
  ])('governs ordinary %i-line source', (lines, aboveComfort, status) => {
    const [row] = evaluateInventory(
      ordinaryPolicy(),
      new Map([['src/owner.ts', Buffer.from('// comment\n'.repeat(lines))]]),
    )
    expect(row).toMatchObject({
      lines,
      aboveComfort,
      status,
      governingRule: 'ordinary',
      declaredLimit: 1000,
      effectiveLimit: 1000,
    })
  })
  it.each([
    ['', 0],
    ['x', 1],
    ['x\n', 1],
    ['\n', 1],
    ['\n\n', 2],
    ['x\r\ny\r\n', 2],
    ['x\r\ny', 2],
  ])('counts exact physical bytes %j', (source, count) => {
    expect(physicalLines(Buffer.from(source))).toBe(count)
  })
  it('retains a named limit below both comfort and default', () => {
    const policy = ordinaryPolicy()
    policy.budgets.push(budget('stricter', 100))
    const [row] = evaluateInventory(
      policy,
      new Map([['src/owner.ts', Buffer.from('\n'.repeat(101))]]),
      new Map([['src/owner.ts', [90]]]),
    )
    expect(row).toMatchObject({ effectiveLimit: 90, aboveComfort: false, status: 'over' })
  })
  it.each([
    'root',
    'extension',
    'duplicate',
    'kind',
    'maximum',
    'metadata',
    'unknown',
    'wildcard',
  ])('rejects malformed or conflicting %s', (defect) => {
    const policy = {
      ...ordinaryPolicy(),
      budgets: [{ ...budget() } as Record<string, unknown>],
    }
    if (defect === 'root') policy.roots.pop()
    if (defect === 'extension') policy.extensions.pop()
    if (defect === 'duplicate') policy.budgets.push({ ...budget() })
    if (defect === 'kind') policy.budgets[0]!.kind = 'unlimited'
    if (defect === 'maximum') policy.budgets[0]!.maxLines = 1.5
    if (defect === 'metadata') delete policy.budgets[0]!.removalIssue
    if (defect === 'unknown') (policy as Record<string, unknown>).exclusions = ['src']
    if (defect === 'wildcard') policy.budgets[0]!.path = 'src/*'
    expect(() => validatePolicy(policy)).toThrow()
  })
  it('covers roots, all source families, shell hooks, local additions, and one owned alias target', () => {
    const r = repo(),
      policy = ordinaryPolicy()
    for (const root of policy.roots) r.write(`${root}/module.ts`, '// source\n')
    for (const extension of policy.extensions)
      r.write(`test/module${extension}`, '// source\n')
    r.write('.githooks/pre-push', '#!/usr/bin/env bash\necho check\n')
    r.write('root.cjs', '// root\n')
    r.commit()
    symlinkSync('../.claude', join(r.root, '.agents/alias'))
    r.source(1001, 'scripts/new.mjs')
    const inventory = collectInventory(r.root, policy)
    expect(inventory.size).toBe(policy.roots.length + policy.extensions.length + 2)
    expect(inventory.has('.agents/alias/module.ts')).toBe(false)
    expect(
      evaluateInventory(policy, inventory).find((e) => e.path === 'scripts/new.mjs')!
        .status,
    ).toBe('over')
    r.commit()
    expect(
      [...collectInventory(r.root, policy, r.git('rev-parse', 'HEAD')).keys()].sort(),
    ).toEqual([...inventory.keys()].sort())
  })
  it.each(['outside', 'language', 'alias', 'tracked-output'])(
    'rejects incomplete inventory: %s',
    (defect) => {
      const r = repo()
      if (defect === 'outside') r.source(1, 'undeclared/a.ts')
      if (defect === 'language') r.write('src/a.py', 'print(1)')
      if (defect === 'alias') symlinkSync('../../outside', join(r.root, 'bad'))
      if (defect === 'tracked-output') {
        r.source(1, 'out/maintained.ts')
        r.commit()
      }
      expect(() => collectInventory(r.root, ordinaryPolicy())).toThrow()
    },
  )
  it('skips only an untracked escaping or broken alias that Git ignores', () => {
    const r = repo(),
      policy = ordinaryPolicy()
    r.source(1, 'src/owner.ts')
    r.write(
      '.git/info/exclude',
      '/.claude/skills/tool\n/.claude/skills/stale\n/vendor/\n',
    )
    r.write('.claude/skills/.keep', '')
    symlinkSync(tmpdir(), join(r.root, '.claude/skills/tool'))
    symlinkSync('missing', join(r.root, '.claude/skills/stale'))
    expect([...collectInventory(r.root, policy).keys()]).toEqual(['src/owner.ts'])
    symlinkSync(tmpdir(), join(r.root, '.claude/skills/other'))
    expect(() => collectInventory(r.root, policy)).toThrow(
      /Escaping or unowned source alias: .claude\/skills\/other/,
    )
    r.remove('.claude/skills/other')
    r.write('vendor/.keep', '')
    symlinkSync(tmpdir(), join(r.root, 'vendor/link'))
    r.git('add', '-f', 'vendor/link')
    r.git('commit', '-m', 'tracked alias under an ignored directory')
    expect(() => collectInventory(r.root, policy)).toThrow(
      /Escaping or unowned source alias: vendor\/link/,
    )
  })
  it('does not turn a changed extension or ignored maintained file into an exemption', () => {
    const r = repo()
    r.write('.gitignore', 'src/hidden.ts\n')
    r.source(1001, 'src/hidden.ts')
    expect(
      evaluateInventory(
        ordinaryPolicy(),
        collectInventory(r.root, ordinaryPolicy()),
      ).find((e) => e.path === 'src/hidden.ts')!.status,
    ).toBe('over')
  })
  it('fails when source disappears while an inventory is being read', () => {
    const r = repo()
    symlinkSync('missing.ts', join(r.root, 'source.ts'))
    expect(() => collectInventory(r.root, ordinaryPolicy())).toThrow(/Unresolved/)
  })
  it('governs generated output separately while its generator remains ordinary', () => {
    const r = repo(),
      policy = ordinaryPolicy()
    r.write('scripts/generate.mjs', '// generator\n')
    r.source(1500, 'src/generated.ts')
    const digest = createHash('sha256')
      .update(r.read('scripts/generate.mjs'))
      .digest('hex')
    policy.generated.push({
      path: 'src/generated.ts',
      maxLines: 1500,
      owner: 'fixture generator',
      rationale: 'Deterministic fixture.',
      reconsiderWhen: 'Generator ownership changes.',
      generator: 'scripts/generate.mjs',
      command: 'node scripts/generate.mjs',
      inputs: [{ path: 'scripts/generate.mjs', sha256: digest }],
    })
    validatePolicy(policy)
    validateGeneratedOwnership(policy, r.read)
    const rows = evaluateInventory(policy, collectInventory(r.root, policy))
    expect(rows.find((r) => r.path === 'src/generated.ts')).toMatchObject({
      status: 'ok',
      governingRule: 'generated',
      effectiveLimit: 1500,
    })
    expect(rows.find((r) => r.path === 'scripts/generate.mjs')!.governingRule).toBe(
      'ordinary',
    )
    r.source(1501, 'src/generated.ts')
    expect(
      evaluateInventory(policy, collectInventory(r.root, policy)).find(
        (r) => r.path === 'src/generated.ts',
      )!.status,
    ).toBe('over')
    r.write('scripts/generate.mjs', '// changed\n')
    expect(() => validateGeneratedOwnership(policy, r.read)).toThrow(/identity mismatch/)
    const updated = {
      ...policy.generated[0]!,
      kind: 'generated' as const,
      inputs: [{ path: 'scripts/generate.mjs', sha256: 'f'.repeat(64) }],
    }
    expect(isRelaxation({ ...policy.generated[0]!, kind: 'generated' }, updated)).toBe(
      false,
    )
    expect(isRelaxation(updated, { ...updated, generator: 'scripts/other.mjs' })).toBe(
      true,
    )
  })
  it('text and structured reports expose comfort, exceptions, and failures', () => {
    const policy = ordinaryPolicy()
    policy.budgets.push(budget('stricter', 100))
    const rows = evaluateInventory(
      policy,
      new Map([
        ['src/owner.ts', Buffer.from('\n'.repeat(101))],
        ['test/large.ts', Buffer.from('\n'.repeat(501))],
      ]),
    )
    const report = {
      mode: 'provisional-report',
      rows,
      violations: rows.filter((r) => r.status === 'over'),
    }
    expect(formatReport(report)).toContain('2 maintained source files')
    expect(formatReport(report)).toContain('! src/owner.ts: 101/100')
    expect(formatReport(report)).toContain('above comfort')
    expect(report.violations).toHaveLength(1)
  })
})
