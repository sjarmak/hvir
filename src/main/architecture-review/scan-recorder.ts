import type {
  ArchitectureScanMetrics,
  ArchitectureScanStage,
  ArchitectureStageSpan,
} from '../../shared/architecture-scan-metrics'

/** Wall-clock milliseconds with sub-millisecond resolution, comparable across processes. */
export type EpochClock = () => number
export const epochClock: EpochClock = () => performance.timeOrigin + performance.now()

/**
 * How far two processes' wall clocks may disagree before a span timed in one is refused by
 * the other. Same-machine clocks differ by well under a millisecond; this leaves room for a
 * slewing clock without admitting a relative or misread timestamp.
 */
export const ARCHITECTURE_CLOCK_SKEW_TOLERANCE_MS = 25

export interface StageMeasurement {
  readonly bytes: number
  readonly items: number
  readonly side?: 'baseline' | 'current'
}

/**
 * Collects the spans of one scan. Host calls are counted by the caller as they are issued,
 * so each span carries the round trips made while it ran. Measured stages never overlap and
 * every host call must fall inside one, so no round trip goes uncredited or misattributed.
 */
export class ArchitectureScanRecorder {
  readonly originEpochMs: number
  private readonly spans: ArchitectureStageSpan[] = []
  private hostCalls = 0
  private active: ArchitectureScanStage | undefined

  constructor(private readonly clock: EpochClock = epochClock) {
    this.originEpochMs = clock()
  }

  countHostCall(): void {
    if (this.active === undefined)
      throw new Error('Architecture scan host call made outside a measured stage')
    this.hostCalls += 1
  }

  async measure<T>(
    stage: ArchitectureScanStage,
    work: () => Promise<T>,
    describe: (result: T) => StageMeasurement,
  ): Promise<T> {
    this.enter(stage)
    const start = this.clock()
    const calls = this.hostCalls
    try {
      const result = await work()
      this.record(stage, start, this.clock(), describe(result), this.hostCalls - calls)
      return result
    } finally {
      this.active = undefined
    }
  }

  measureSync<T>(
    stage: ArchitectureScanStage,
    work: () => T,
    describe: (result: T) => StageMeasurement,
  ): T {
    this.enter(stage)
    const start = this.clock()
    const calls = this.hostCalls
    try {
      const result = work()
      this.record(stage, start, this.clock(), describe(result), this.hostCalls - calls)
      return result
    } finally {
      this.active = undefined
    }
  }

  /**
   * Places a span timed elsewhere, such as in the analysis worker. Clocks of two processes
   * can disagree slightly, so a span within the skew allowance is clamped to start no
   * earlier than the scan and to end no earlier than it starts. Anything further off is a
   * wrong clock or a wrong unit, and is refused rather than hidden by the clamp.
   */
  place(
    stage: ArchitectureScanStage,
    startEpochMs: number,
    endEpochMs: number,
    measurement: StageMeasurement,
  ): void {
    const refuse = (reason: string) => {
      throw new Error(`Architecture scan span for ${stage} ${reason}`)
    }
    const tolerance = ARCHITECTURE_CLOCK_SKEW_TOLERANCE_MS
    if (startEpochMs < this.originEpochMs - tolerance) refuse('starts before the scan')
    if (endEpochMs < startEpochMs - tolerance) refuse('ends before it starts')
    if (endEpochMs > this.clock() + tolerance) refuse('ends in the future')
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

  private enter(stage: ArchitectureScanStage): void {
    if (this.active !== undefined)
      throw new Error(`Architecture scan stage ${stage} overlaps ${this.active}`)
    this.active = stage
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
