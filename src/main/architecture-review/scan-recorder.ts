import type {
  ArchitectureScanMetrics,
  ArchitectureScanStage,
  ArchitectureStageSpan,
} from '../../shared/architecture-scan-metrics'

/**
 * This process's clock: milliseconds with sub-millisecond resolution, anchored at the wall
 * clock when the process started. It is monotonic, so it stops while the machine sleeps and
 * a long-lived process falls behind the wall clock by every suspend it lived through. Marks
 * are comparable only within one process; `wall-clock.ts` carries them across processes.
 */
export type ProcessClock = () => number
export const processClock: ProcessClock = () => performance.timeOrigin + performance.now()

/**
 * How far a mark carried from another process through the wall clock may fall outside the
 * window main observed. Each translation is exact to the wall clock's 1 ms tick; this leaves
 * room for that and a slewing clock without admitting a relative or misread timestamp.
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
  readonly originMs: number
  private readonly spans: ArchitectureStageSpan[] = []
  private readonly timingFaults: string[] = []
  private hostCalls = 0
  private active: ArchitectureScanStage | undefined

  constructor(private readonly clock: ProcessClock = processClock) {
    this.originMs = clock()
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
   * Places a span timed outside `measure`, as marks on this process's clock: an in-process
   * analysis stage, or a worker stage translated through the wall clock. A translated mark is
   * exact only to the skew allowance, so a span within it is clamped to start no earlier
   * than the scan and to end no earlier than it starts. Anything further off is a wrong
   * clock or a wrong unit, and is refused rather than hidden by the clamp.
   */
  place(
    stage: ArchitectureScanStage,
    startMark: number,
    endMark: number,
    measurement: StageMeasurement,
  ): void {
    const refuse = (reason: string) => {
      throw new Error(`Architecture scan span for ${stage} ${reason}`)
    }
    const tolerance = ARCHITECTURE_CLOCK_SKEW_TOLERANCE_MS
    if (startMark < this.originMs - tolerance) refuse('starts before the scan')
    if (endMark < startMark - tolerance) refuse('ends before it starts')
    if (endMark > this.clock() + tolerance) refuse('ends in the future')
    this.record(stage, startMark, endMark, measurement, 0)
  }

  /**
   * Records why stages that ran are missing from the spans, so the snapshot shows the gap
   * instead of failing the scan the timings describe.
   */
  noteTimingFault(message: string): void {
    this.timingFaults.push(message)
  }

  metrics(): ArchitectureScanMetrics {
    const spans = [...this.spans].sort((left, right) => left.startMs - right.startMs)
    const end = Math.max(
      this.clock() - this.originMs,
      ...spans.map((span) => span.startMs + span.durationMs),
    )
    return { spans, totalMs: end, timingFaults: [...this.timingFaults] }
  }

  private enter(stage: ArchitectureScanStage): void {
    if (this.active !== undefined)
      throw new Error(`Architecture scan stage ${stage} overlaps ${this.active}`)
    this.active = stage
  }

  private record(
    stage: ArchitectureScanStage,
    startMark: number,
    endMark: number,
    measurement: StageMeasurement,
    hostCalls: number,
  ): void {
    for (const value of [startMark, endMark])
      if (!Number.isFinite(value))
        throw new Error(`Invalid architecture scan measurement for ${stage}`)
    for (const value of [measurement.bytes, measurement.items])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`Invalid architecture scan measurement for ${stage}`)
    const startMs = Math.max(0, startMark - this.originMs)
    this.spans.push({
      stage,
      ...(measurement.side ? { side: measurement.side } : {}),
      startMs,
      durationMs: Math.max(0, endMark - this.originMs - startMs),
      bytes: measurement.bytes,
      items: measurement.items,
      hostCalls,
    })
  }
}
