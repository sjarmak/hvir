import { expect, it } from 'vitest'
import {
  formatScanBytes,
  formatScanMs,
  scanTimingRows,
} from '../src/renderer/src/architecture-review/architecture-scan-timings-model'

it('formats durations and transfer sizes for the snapshot details', () => {
  expect(formatScanMs(0)).toBe('0.0 ms')
  expect(formatScanMs(1234.56)).toBe('1.23 s')
  expect(formatScanBytes(1023)).toBe('1023 B')
  expect(formatScanBytes(2048)).toBe('2.0 KB')
  expect(formatScanBytes(3 * 1024 * 1024)).toBe('3.0 MB')
})

it('builds one row per stage that ran, in pipeline order', () => {
  const rows = scanTimingRows({
    totalMs: 10,
    spans: [
      {
        stage: 'parse',
        side: 'baseline',
        startMs: 5,
        durationMs: 1,
        bytes: 10,
        items: 1,
        hostCalls: 0,
      },
      { stage: 'listing', startMs: 0, durationMs: 2, bytes: 5, items: 1, hostCalls: 1 },
      {
        stage: 'parse',
        side: 'current',
        startMs: 6,
        durationMs: 2,
        bytes: 20,
        items: 2,
        hostCalls: 0,
      },
    ],
  })
  expect(rows).toEqual([
    { stage: 'listing', time: '2.0 ms', bytes: '5 B', items: '1', hostCalls: '1' },
    { stage: 'parse', time: '3.0 ms', bytes: '30 B', items: '3', hostCalls: '0' },
  ])
})
