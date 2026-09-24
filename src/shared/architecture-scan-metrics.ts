/**
 * Per-stage cost of one architecture scan (ADR-063: every scan records per-stage timings and
 * transfer sizes). Spans are ordered by start on one timeline whose origin is the scan start;
 * spans reported by the analysis worker are placed on it by wall-clock conversion.
 */
export const ARCHITECTURE_SCAN_STAGES = [
  'listing',
  'blob-read',
  'live-read',
  'live-recheck',
  'hashing',
  'worker-spawn',
  'worker-transfer',
  'parse',
  'compare',
  'worker-return',
  'renderer-payload',
] as const

export type ArchitectureScanStage = (typeof ARCHITECTURE_SCAN_STAGES)[number]

export interface ArchitectureStageSpan {
  readonly stage: ArchitectureScanStage
  /** Which end of the snapshot the span read or parsed, when it concerns one end. */
  readonly side?: 'baseline' | 'current'
  /** Milliseconds from the scan start. */
  readonly startMs: number
  readonly durationMs: number
  /** Bytes read, hashed, parsed or transferred by this span. */
  readonly bytes: number
  /** Files, blobs or listing records the span handled. */
  readonly items: number
  /** Host round trips the span issued (commands, stats, reads). */
  readonly hostCalls: number
}

export interface ArchitectureScanMetrics {
  readonly spans: readonly ArchitectureStageSpan[]
  /** Milliseconds from the scan start to the snapshot being complete. */
  readonly totalMs: number
}

export interface ArchitectureStageTotal {
  readonly stage: ArchitectureScanStage
  readonly spans: number
  readonly durationMs: number
  readonly bytes: number
  readonly items: number
  readonly hostCalls: number
}

/** Totals per stage in pipeline order; stages the scan never ran are omitted. */
export function summarizeArchitectureStages(
  spans: readonly ArchitectureStageSpan[],
): readonly ArchitectureStageTotal[] {
  return ARCHITECTURE_SCAN_STAGES.flatMap((stage) => {
    const matching = spans.filter((span) => span.stage === stage)
    if (matching.length === 0) return []
    return [
      {
        stage,
        spans: matching.length,
        durationMs: sum(matching.map((span) => span.durationMs)),
        bytes: sum(matching.map((span) => span.bytes)),
        items: sum(matching.map((span) => span.items)),
        hostCalls: sum(matching.map((span) => span.hostCalls)),
      },
    ]
  })
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
