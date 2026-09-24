import {
  summarizeArchitectureStages,
  type ArchitectureScanMetrics,
  type ArchitectureScanStage,
} from '../../../shared/architecture-scan-metrics'

export interface ScanTimingRow {
  readonly stage: ArchitectureScanStage
  readonly time: string
  readonly bytes: string
  readonly items: string
  readonly hostCalls: string
}

export function formatScanMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`
}

export function formatScanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One display row per stage the scan ran, in pipeline order. */
export function scanTimingRows(
  metrics: ArchitectureScanMetrics,
): readonly ScanTimingRow[] {
  return summarizeArchitectureStages(metrics.spans).map((total) => ({
    stage: total.stage,
    time: formatScanMs(total.durationMs),
    bytes: formatScanBytes(total.bytes),
    items: String(total.items),
    hostCalls: String(total.hostCalls),
  }))
}
