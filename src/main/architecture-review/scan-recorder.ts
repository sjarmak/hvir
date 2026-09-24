import type {
  ArchitectureScanMetrics,
  ArchitectureScanStage,
  ArchitectureStageSpan,
} from '../../shared/architecture-scan-metrics'

/** Wall-clock milliseconds with sub-millisecond resolution, comparable across processes. */
export type EpochClock = () => number
export const epochClock: EpochClock = () => performance.timeOrigin + performance.now()

export interface StageMeasurement {
  readonly bytes: number
  readonly items: number
  readonly side?: 'baseline' | 'current'
}

/**
 * Collects the spans of one scan. Host calls are counted by the caller as they are issued,
 * so each span carries the round trips made while it ran; scans are sequential per recorder.
 */
export class ArchitectureScanRecorder {
  readonly originEpochMs: number
  private readonly spans: ArchitectureStageSpan[] = []
  private hostCalls = 0

  constructor(private readonly clock: EpochClock = epochClock) {
    this.originEpochMs = clock()
  }

  countHostCall(): void {
    this.hostCalls += 1
  }

  async measure<T>(
    stage: ArchitectureScanStage,
    work: () => Promise<T>,
    describe: (result: T) => StageMeasurement,
  ): Promise<T> {
    const start = this.clock()
    const calls = this.hostCalls
    const result = await work()
    this.record(stage, start, this.clock(), describe(result), this.hostCalls - calls)
    return result
  }

  measureSync<T>(
    stage: ArchitectureScanStage,
    work: () => T,
    describe: (result: T) => StageMeasurement,
  ): T {
    const start = this.clock()
    const calls = this.hostCalls
    const result = work()
    this.record(stage, start, this.clock(), describe(result), this.hostCalls - calls)
    return result
  }

  /**
   * Places a span timed elsewhere, such as in the analysis worker. Clocks of two processes
   * can disagree by a fraction of a millisecond, so a span is clamped to start no earlier
   * than the scan and to end no earlier than it starts.
   */
  place(
    stage: ArchitectureScanStage,
    startEpochMs: number,
    endEpochMs: number,
    measurement: StageMeasurement,
  ): void {
    this.record(stage, startEpochMs, endEpochMs, measurement, 0)
  }

  metrics(): ArchitectureScanMetrics {
    const spans = [...this.spans].sort((left, right) => left.startMs - right.startMs)
    const end = Math.max(
      this.clock() - this.originEpochMs,
      ...spans.map((span) => span.startMs + span.durationMs),
    )
    return { spans, totalMs: end }
  }

  private record(
    stage: ArchitectureScanStage,
    startEpochMs: number,
    endEpochMs: number,
    measurement: StageMeasurement,
    hostCalls: number,
  ): void {
    for (const value of [startEpochMs, endEpochMs])
      if (!Number.isFinite(value))
        throw new Error(`Invalid architecture scan measurement for ${stage}`)
    for (const value of [measurement.bytes, measurement.items])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`Invalid architecture scan measurement for ${stage}`)
    const startMs = Math.max(0, startEpochMs - this.originEpochMs)
    this.spans.push({
      stage,
      ...(measurement.side ? { side: measurement.side } : {}),
      startMs,
      durationMs: Math.max(0, endEpochMs - this.originEpochMs - startMs),
      bytes: measurement.bytes,
      items: measurement.items,
      hostCalls,
    })
  }
}
