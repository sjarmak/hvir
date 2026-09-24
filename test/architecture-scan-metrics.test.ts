import { expect, it } from 'vitest'
import { summarizeArchitectureStages } from '../src/shared/architecture-scan-metrics'
import { ArchitectureScanRecorder } from '../src/main/architecture-review/scan-recorder'
import { expectMonotoneMetrics } from './architecture-scan-metrics-fixture'

/** A clock that advances by a fixed step on every read, so ordering is observable. */
function steppingClock(start = 1_000, step = 5) {
  let now = start - step
  return () => (now += step)
}

it('records spans on one timeline with host calls counted per span', async () => {
  const recorder = new ArchitectureScanRecorder(steppingClock())
  const listing = await recorder.measure(
    'listing',
    () => {
      recorder.countHostCall()
      return Promise.resolve('a\0b\0')
    },
    (output) => ({ bytes: output.length, items: 2 }),
  )
  expect(listing).toBe('a\0b\0')
  recorder.measureSync(
    'hashing',
    () => 'digest',
    () => ({ bytes: 64, items: 1 }),
  )
  const metrics = recorder.metrics()
  expect(metrics.spans.map((span) => span.stage)).toEqual(['listing', 'hashing'])
  expect(metrics.spans[0]).toMatchObject({ bytes: 4, items: 2, hostCalls: 1 })
  expect(metrics.spans[1]).toMatchObject({ bytes: 64, items: 1, hostCalls: 0 })
  expectMonotoneMetrics(metrics)
})

it('places externally timed spans by wall clock and clamps skew below the origin', () => {
  const recorder = new ArchitectureScanRecorder(steppingClock(10_000, 1))
  recorder.place('worker-spawn', 9_990, 10_020, { bytes: 0, items: 1 })
  recorder.place('parse', 10_030, 10_025, { bytes: 10, items: 1, side: 'current' })
  const [spawn, parse] = recorder.metrics().spans
  expect(spawn).toMatchObject({ startMs: 0, durationMs: 20 })
  expect(parse).toMatchObject({ startMs: 30, durationMs: 0, side: 'current' })
  expectMonotoneMetrics(recorder.metrics())
})

it('rejects impossible measurements rather than recording them', () => {
  const recorder = new ArchitectureScanRecorder(steppingClock())
  expect(() =>
    recorder.measureSync(
      'hashing',
      () => 1,
      () => ({ bytes: -1, items: 0 }),
    ),
  ).toThrow(/measurement/)
  expect(() => recorder.place('parse', 1, 2, { bytes: Number.NaN, items: 0 })).toThrow(
    /measurement/,
  )
})

it('does not record a span for work that fails', async () => {
  const recorder = new ArchitectureScanRecorder(steppingClock())
  await expect(
    recorder.measure(
      'listing',
      () => Promise.reject(new Error('git failed')),
      () => ({ bytes: 0, items: 0 }),
    ),
  ).rejects.toThrow('git failed')
  expect(recorder.metrics().spans).toEqual([])
})

it('summarizes stages in pipeline order and omits stages that never ran', () => {
  const totals = summarizeArchitectureStages([
    {
      stage: 'parse',
      side: 'current',
      startMs: 4,
      durationMs: 3,
      bytes: 30,
      items: 3,
      hostCalls: 0,
    },
    { stage: 'listing', startMs: 0, durationMs: 1, bytes: 5, items: 2, hostCalls: 1 },
    {
      stage: 'parse',
      side: 'baseline',
      startMs: 2,
      durationMs: 2,
      bytes: 20,
      items: 2,
      hostCalls: 0,
    },
  ])
  expect(totals).toEqual([
    { stage: 'listing', spans: 1, durationMs: 1, bytes: 5, items: 2, hostCalls: 1 },
    { stage: 'parse', spans: 2, durationMs: 5, bytes: 50, items: 5, hostCalls: 0 },
  ])
})
