import { expect, it } from 'vitest'
import {
  ArchitectureExplanationError,
  checkArchitectureExplanation,
  parseArchitectureExplanation,
} from '../src/shared/architecture-explanation'
import type { ArchitectureExplanationClaim } from '../src/shared/architecture-explanation'
import type { ArchitectureReviewSnapshot } from '../src/shared/architecture-review'
import { localPath } from '../src/shared/host-path'

const snapshot = {
  id: 'snapshot-1',
  root: localPath('/repo'),
  baselineRef: 'main',
  currentRef: 'HEAD',
  baselineRevision: 'a'.repeat(40),
  currentRevision: 'b'.repeat(40),
  fingerprint: 'fingerprint',
  exclusions: [],
  layout: {
    origin: 'default',
    scope: [],
    sourceRoots: ['src'],
    systems: [],
    subsystems: [],
  },
  capturedAt: '2026-09-25T00:00:00Z',
  analysis: {
    before: {
      fingerprint: 'a',
      scope: '.',
      exclusions: [],
      modules: [],
      imports: [],
      diagnostics: [],
    },
    after: {
      fingerprint: 'b',
      scope: '.',
      exclusions: [],
      modules: [],
      imports: [],
      diagnostics: [],
    },
    modules: [
      {
        path: 'src/main/start.ts',
        system: 'Desktop',
        subsystem: 'Main',
        hash: 'hash',
        symbols: [],
        change: 'changed',
      },
    ],
    imports: [],
    relationships: [],
  },
  metrics: { totalMs: 1, spans: [], timingFaults: [] },
} satisfies ArchitectureReviewSnapshot

const value = {
  version: 1,
  snapshotId: 'snapshot-1',
  whatChanged: 'The launch path changed.',
  why: 'The provider now owns the decision.',
  sequenceDiagram: 'sequenceDiagram\n  User->>Workbench: Explain',
  touched: {
    systems: ['Desktop', 'Invented system'],
    subsystems: ['Main', 'Invented subsystem'],
    modules: ['src/main/start.ts', 'src/missing.ts'],
  },
} satisfies ArchitectureExplanationClaim

it('strictly parses an explanation and preserves the agent claim', () => {
  expect(parseArchitectureExplanation(JSON.stringify(value))).toEqual(value)
})

it('flags every exact name absent from the snapshot without judging the prose', () => {
  expect(checkArchitectureExplanation(value, snapshot)).toEqual({
    snapshotId: 'snapshot-1',
    claim: value,
    names: {
      systems: [
        { name: 'Desktop', present: true },
        { name: 'Invented system', present: false },
      ],
      subsystems: [
        { name: 'Main', present: true },
        { name: 'Invented subsystem', present: false },
      ],
      modules: [
        { name: 'src/main/start.ts', present: true },
        { name: 'src/missing.ts', present: false },
      ],
    },
  })
})

it('refuses mismatched snapshots, unknown keys, duplicates, and malformed diagrams', () => {
  const invalid = [
    { ...value, snapshotId: 'other' },
    { ...value, extra: true },
    {
      ...value,
      touched: { ...value.touched, modules: ['src/main/start.ts', 'src/main/start.ts'] },
    },
    { ...value, sequenceDiagram: '' },
    { ...value, sequenceDiagram: 'graph TD\n  A-->B' },
    { ...value, sequenceDiagram: 'sequenceDiagram\nsequenceDiagram' },
  ]
  expect(() => checkArchitectureExplanation(invalid[0]!, snapshot)).toThrow(
    /different snapshot/,
  )
  for (const candidate of invalid.slice(1))
    expect(() => parseArchitectureExplanation(JSON.stringify(candidate))).toThrow(
      ArchitectureExplanationError,
    )
})
