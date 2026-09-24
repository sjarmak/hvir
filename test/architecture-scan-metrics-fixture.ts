import { expect } from 'vitest'
import {
  ARCHITECTURE_SCAN_STAGES,
  type ArchitectureScanMetrics,
} from '../src/shared/architecture-scan-metrics'

/** Every span is finite, non-negative, ordered by start and inside the scan total. */
export function expectMonotoneMetrics(metrics: ArchitectureScanMetrics): void {
  expect(Number.isFinite(metrics.totalMs)).toBe(true)
  expect(metrics.totalMs).toBeGreaterThanOrEqual(0)
  let previous = 0
  for (const span of metrics.spans) {
    expect(ARCHITECTURE_SCAN_STAGES).toContain(span.stage)
    for (const value of [
      span.startMs,
      span.durationMs,
      span.bytes,
      span.items,
      span.hostCalls,
    ]) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(span.startMs).toBeGreaterThanOrEqual(previous)
    expect(span.startMs + span.durationMs).toBeLessThanOrEqual(metrics.totalMs + 1e-6)
    previous = span.startMs
  }
}

export function stagesOf(metrics: ArchitectureScanMetrics): readonly string[] {
  return [...new Set(metrics.spans.map((span) => span.stage))].sort()
}
