import type { ArchitectureScanMetrics } from '../../../shared/architecture-scan-metrics'
import { formatScanMs, scanTimingRows } from './architecture-scan-timings-model'

interface ArchitectureScanTimingsProps {
  readonly metrics: ArchitectureScanMetrics
}

/** Per-stage cost of the scan that produced this snapshot (ADR-063). */
export function ArchitectureScanTimings({ metrics }: ArchitectureScanTimingsProps) {
  return (
    <table className="architecture-review-timings" aria-label="Scan timings">
      <caption>Scan timings · {formatScanMs(metrics.totalMs)} total</caption>
      <thead>
        <tr>
          <th scope="col">Stage</th>
          <th scope="col">Time</th>
          <th scope="col">Bytes</th>
          <th scope="col">Items</th>
          <th scope="col">Host calls</th>
        </tr>
      </thead>
      <tbody>
        {scanTimingRows(metrics).map((row) => (
          <tr key={row.stage}>
            <th scope="row">{row.stage}</th>
            <td>{row.time}</td>
            <td>{row.bytes}</td>
            <td>{row.items}</td>
            <td>{row.hostCalls}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
