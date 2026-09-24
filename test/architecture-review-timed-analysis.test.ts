import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { ArchitectureCapture } from '../src/shared/architecture-review'
import { ARCHITECTURE_DEFAULT_LAYOUT } from '../src/shared/architecture-layout'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'
import {
  analyzeCaptureTimed,
  captureScanInputs,
} from '../src/main/architecture-review/timed-analysis'
import { gitBlobId } from '../src/main/architecture-review/blob-id'

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
  before: [source('src/a.ts', "import './b'")],
  after: [source('src/a.ts', "import './b'"), source('src/b.ts', 'export const b = 1')],
  configs: { before: [], after: [] },
  exclusions: [],
  layout: ARCHITECTURE_DEFAULT_LAYOUT,
  capturedAt: 'now',
}

it('times each side parse and the comparison without changing the analysis', async () => {
  let now = 100
  const timed = await analyzeCaptureTimed(capture, () => (now += 2))
  expect(timed.analysis).toEqual(analyzeArchitecture(...captureScanInputs(capture)))
  expect(timed.stages.map((stage) => [stage.stage, stage.side])).toEqual([
    ['parse', 'baseline'],
    ['parse', 'current'],
    ['compare', undefined],
  ])
  expect(timed.stages[0]).toMatchObject({ items: 1, bytes: 12 })
  expect(timed.stages[1]).toMatchObject({ items: 2, bytes: 30 })
  let previous = 0
  for (const stage of timed.stages) {
    expect(stage.startMark).toBeGreaterThanOrEqual(previous)
    expect(stage.endMark).toBeGreaterThanOrEqual(stage.startMark)
    previous = stage.endMark
  }
})
