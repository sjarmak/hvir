import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArchitectureCapture } from '../src/shared/architecture-review'

let respond: ((request: unknown) => Promise<unknown>) | undefined
const clients: Array<{
  readonly dispose: ReturnType<typeof vi.fn>
  readonly request: ReturnType<typeof vi.fn>
}> = []

vi.mock('../src/main/worker-host', () => ({
  createWorkerClient: vi.fn(() => {
    let rejectRequest: ((reason: Error) => void) | undefined
    const dispose = vi.fn(() => {
      const reject = rejectRequest
      rejectRequest = undefined
      reject?.(new Error('worker client disposed'))
    })
    const request = vi.fn((_type: string, payload: unknown) =>
      respond
        ? respond(payload)
        : new Promise<never>((_resolve, reject) => {
            rejectRequest = reject
          }),
    )
    const client = { dispose, request }
    clients.push(client)
    return client
  }),
  workerPath: vi.fn(() => '/tmp/architecture-worker.js'),
}))

import { ArchitectureAnalysisWorker } from '../src/main/architecture-review/worker'
import { analyzeCaptureTimed } from '../src/main/architecture-review/timed-analysis'
import {
  ArchitectureScanRecorder,
  processClock,
  type ProcessClock,
} from '../src/main/architecture-review/scan-recorder'
import { reportWorkerTimings } from '../src/main/architecture-review/worker-timings'
import { translateClock } from '../src/main/architecture-review/wall-clock'
import { localPath } from '../src/shared/host-path'
import { expectMonotoneMetrics, stagesOf } from './architecture-scan-metrics-fixture'
import { gitBlobId } from '../src/main/architecture-review/blob-id'

const source = (path: string, content: string) => ({
  path,
  content,
  object: gitBlobId(Buffer.from(content)),
})

const capture = {} as ArchitectureCapture
/** A worker used for one request only, as every scan was before processes stayed warm. */
const analyzeInWorker = (
  ...args: Parameters<ArchitectureAnalysisWorker['analyze']>
): ReturnType<ArchitectureAnalysisWorker['analyze']> =>
  new ArchitectureAnalysisWorker().analyze(...args)

afterEach(() => {
  respond = undefined
  vi.useRealTimers()
  clients.length = 0
})

describe('architecture analysis worker lifecycle', () => {
  it('disposes the utility worker when the request is aborted', async () => {
    const controller = new AbortController()
    const pending = analyzeInWorker(capture, controller.signal)
    const assertion = expect(pending).rejects.toThrow('worker client disposed')
    controller.abort(new Error('cancelled'))

    await assertion
    expect(clients).toHaveLength(1)
    expect(clients[0]?.dispose).toHaveBeenCalled()
  })

  it('disposes the utility worker when the bounded request times out', async () => {
    vi.useFakeTimers()
    const pending = analyzeInWorker(capture, new AbortController().signal)
    const assertion = expect(pending).rejects.toThrow('worker client disposed')
    await vi.advanceTimersByTimeAsync(60_001)

    await assertion
    expect(clients).toHaveLength(1)
    expect(clients[0]?.dispose).toHaveBeenCalled()
  })
})

describe('architecture analysis worker timings', () => {
  const pair: ArchitectureCapture = {
    root: localPath('/repo'),
    baselineRef: 'HEAD',
    currentRef: 'working tree',
    baselineRevision: 'b',
    currentRevision: 'c',
    fingerprint: 'f',
    before: [source('a.ts', 'export {}')],
    after: [source('a.ts', "import './b'")],
    configs: { before: [], after: [source('tsconfig.json', '{}')] },
    exclusions: [],
    capturedAt: 'now',
  }
  /** Answers the way the worker module does, reading `clock` as its own process clock. */
  function workerAnswering(clock: ProcessClock) {
    return async (payload: unknown) => {
      const readyMark = clock()
      const receivedMark = clock()
      const timed = await analyzeCaptureTimed(
        (payload as { capture: ArchitectureCapture }).capture,
        clock,
      )
      const marks = { readyMark, receivedMark, respondedMark: clock(), resultBytes: 321 }
      return {
        analysis: timed.analysis,
        timings: reportWorkerTimings(
          { ...marks, stages: timed.stages },
          translateClock(clock),
        ),
      }
    }
  }

  it('places spawn, transfer, parse, compare and return spans on the scan timeline', async () => {
    respond = workerAnswering(processClock)
    const recorder = new ArchitectureScanRecorder()
    const analysis = await analyzeInWorker(pair, new AbortController().signal, recorder)
    expect(analysis.modules.map((module) => module.path)).toEqual(['a.ts'])
    const metrics = recorder.metrics()
    expectMonotoneMetrics(metrics)
    expect(metrics.timingFaults).toEqual([])
    expect(stagesOf(metrics)).toEqual([
      'compare',
      'parse',
      'worker-return',
      'worker-spawn',
      'worker-transfer',
    ])
    expect(metrics.spans.find((span) => span.stage === 'worker-transfer')).toMatchObject({
      bytes:
        'a.ts'.length * 2 +
        'export {}'.length +
        "import './b'".length +
        'tsconfig.json{}'.length,
      items: 3,
    })
    expect(metrics.spans.find((span) => span.stage === 'worker-return')).toMatchObject({
      bytes: 321,
    })
  })

  // Main's monotonic clock stops while the machine sleeps; a freshly spawned worker's does
  // not carry that lag, so the two process clocks disagree by the sleep main lived through.
  it.each([30, 150, -150, 60_000, 3_600_000])(
    'places worker spans when main and worker process clocks disagree by %i ms',
    async (skewMs) => {
      respond = workerAnswering(() => processClock() + skewMs)
      const recorder = new ArchitectureScanRecorder()
      await analyzeInWorker(pair, new AbortController().signal, recorder)
      const metrics = recorder.metrics()
      expect(metrics.timingFaults).toEqual([])
      expectMonotoneMetrics(metrics)
      expect(stagesOf(metrics)).toContain('parse')
      expect(metrics.totalMs).toBeLessThan(10_000)
    },
  )

  it('keeps the analysis and reports a timing fault when the timings are malformed', async () => {
    const modules = [{ path: 'kept.ts' }]
    respond = () =>
      Promise.resolve({
        analysis: { modules },
        timings: { readyEpochMs: 'soon', stages: [] },
      })
    const recorder = new ArchitectureScanRecorder()
    const analysis = await analyzeInWorker(
      { ...capture, before: [], after: [] },
      new AbortController().signal,
      recorder,
    )
    expect(analysis.modules).toBe(modules)
    const metrics = recorder.metrics()
    expect(metrics.spans).toEqual([])
    expect(metrics.timingFaults).toEqual([
      'Worker stages not shown: Architecture worker returned malformed timings',
    ])
  })

  const emptyPair = {
    ...capture,
    before: [],
    after: [],
    configs: { before: [], after: [] },
  }
  /** Wall-clock timings a well-behaved worker would report for a request made now. */
  function plausibleTimings() {
    const now = Date.now()
    return {
      readyEpochMs: now + 1,
      receivedEpochMs: now + 2,
      respondedEpochMs: now + 5,
      resultBytes: 10,
      stages: [
        {
          stage: 'parse',
          side: 'current',
          startEpochMs: now + 3,
          endEpochMs: now + 4,
          bytes: 0,
          items: 0,
        },
      ],
    }
  }
  type Timings = ReturnType<typeof plausibleTimings>
  const withStage = (timings: Timings, patch: Record<string, unknown>) => ({
    ...timings,
    stages: [{ ...timings.stages[0]!, ...patch }],
  })

  it.each([
    [
      'a stage side that is not baseline or current',
      (t: Timings) => withStage(t, { side: 'left' }),
    ],
    [
      'relative milliseconds instead of wall-clock marks',
      () => ({
        readyEpochMs: 5,
        receivedEpochMs: 6,
        respondedEpochMs: 7,
        resultBytes: 1,
        stages: [],
      }),
    ],
    [
      'a request received before the worker was ready',
      (t: Timings) => ({
        ...t,
        receivedEpochMs: t.readyEpochMs - 1_000,
      }),
    ],
    [
      'a response stamped far in the future',
      (t: Timings) => ({
        ...t,
        respondedEpochMs: t.respondedEpochMs + 1e9,
      }),
    ],
    [
      'a stage that ends before it starts',
      (t: Timings) => withStage(t, { endEpochMs: t.stages[0]!.startEpochMs - 1_000 }),
    ],
    [
      'a stage outside the request it belongs to',
      (t: Timings) => withStage(t, { startEpochMs: t.readyEpochMs - 1_000 }),
    ],
    [
      'a stage stamped after the worker returned',
      (t: Timings) => withStage(t, { endEpochMs: t.respondedEpochMs + 1_000 }),
    ],
    ['a fractional result size', (t: Timings) => ({ ...t, resultBytes: 1.5 })],
  ])('records no worker span for %s', async (_label, corrupt) => {
    respond = () =>
      Promise.resolve({
        analysis: { modules: [] },
        timings: corrupt(plausibleTimings()),
      })
    const recorder = new ArchitectureScanRecorder()
    await analyzeInWorker(emptyPair, new AbortController().signal, recorder)
    const metrics = recorder.metrics()
    expect(metrics.spans).toEqual([])
    expect(metrics.timingFaults).toHaveLength(1)
    expect(metrics.timingFaults[0]).toMatch(/malformed timings/)
  })

  it('accepts plausible wall-clock timings', async () => {
    respond = () =>
      Promise.resolve({ analysis: { modules: [] }, timings: plausibleTimings() })
    const recorder = new ArchitectureScanRecorder()
    await analyzeInWorker(emptyPair, new AbortController().signal, recorder)
    expect(recorder.metrics().timingFaults).toEqual([])
    expectMonotoneMetrics(recorder.metrics())
  })
})

describe('warm architecture analysis worker', () => {
  const pair: ArchitectureCapture = {
    root: localPath('/repo'),
    baselineRef: 'HEAD',
    currentRef: 'working tree',
    baselineRevision: 'b',
    currentRevision: 'c',
    fingerprint: 'f',
    before: [source('a.ts', 'export {}')],
    after: [source('a.ts', 'export {}')],
    configs: { before: [], after: [] },
    exclusions: [],
    capturedAt: 'now',
  }
  const cache = { directory: '/user-data/architecture-parse-cache', maxBytes: 1024 }
  const payloads: unknown[] = []
  /** A process that became ready once, when it was spawned, and answers every request. */
  function warmProcess() {
    const readyMark = processClock()
    return async (payload: unknown) => {
      payloads.push(payload)
      const receivedMark = processClock()
      const timed = await analyzeCaptureTimed(
        (payload as { capture: ArchitectureCapture }).capture,
      )
      const marks = {
        readyMark,
        receivedMark,
        respondedMark: processClock(),
        resultBytes: 1,
      }
      return {
        analysis: timed.analysis,
        timings: reportWorkerTimings(
          { ...marks, stages: timed.stages },
          translateClock(),
        ),
      }
    }
  }
  afterEach(() => {
    payloads.length = 0
  })

  it('reuses one process across scans and sends it the parse cache location', async () => {
    respond = warmProcess()
    const worker = new ArchitectureAnalysisWorker({ cache })
    const first = new ArchitectureScanRecorder()
    await worker.analyze(pair, new AbortController().signal, first)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = new ArchitectureScanRecorder()
    await worker.analyze(pair, new AbortController().signal, second)
    expect(clients).toHaveLength(1)
    expect(clients[0]?.request).toHaveBeenCalledTimes(2)
    expect(clients[0]?.dispose).not.toHaveBeenCalled()
    expect(payloads).toEqual([
      { capture: pair, cache },
      { capture: pair, cache },
    ])
    expect(stagesOf(first.metrics())).toContain('worker-spawn')
    expect(second.metrics().timingFaults).toEqual([])
    expectMonotoneMetrics(second.metrics())
    expect(stagesOf(second.metrics())).toEqual([
      'compare',
      'parse',
      'worker-return',
      'worker-transfer',
    ])
    worker.dispose()
    expect(clients[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('kills the process of a cancelled scan and starts a new one for the next', async () => {
    const worker = new ArchitectureAnalysisWorker()
    const controller = new AbortController()
    const pending = worker.analyze(pair, controller.signal)
    const assertion = expect(pending).rejects.toThrow('worker client disposed')
    controller.abort(new Error('cancelled'))
    await assertion
    respond = warmProcess()
    await worker.analyze(pair, new AbortController().signal)
    expect(clients).toHaveLength(2)
    expect(clients[0]?.dispose).toHaveBeenCalled()
    expect(clients[1]?.dispose).not.toHaveBeenCalled()
    worker.dispose()
  })

  it('does not keep a process whose request failed', async () => {
    respond = () => Promise.reject(new Error('parse exploded'))
    const worker = new ArchitectureAnalysisWorker()
    await expect(worker.analyze(pair, new AbortController().signal)).rejects.toThrow(
      'parse exploded',
    )
    respond = warmProcess()
    await worker.analyze(pair, new AbortController().signal)
    expect(clients).toHaveLength(2)
    expect(clients[0]?.dispose).toHaveBeenCalled()
    worker.dispose()
  })

  it('gives concurrent scans their own processes and keeps one idle', async () => {
    respond = warmProcess()
    const worker = new ArchitectureAnalysisWorker()
    await Promise.all([
      worker.analyze(pair, new AbortController().signal),
      worker.analyze(pair, new AbortController().signal),
    ])
    expect(clients).toHaveLength(2)
    expect(clients.filter((client) => client.dispose.mock.calls.length > 0)).toHaveLength(
      1,
    )
    await worker.analyze(pair, new AbortController().signal)
    expect(clients).toHaveLength(2)
    worker.dispose()
    expect(clients.every((client) => client.dispose.mock.calls.length > 0)).toBe(true)
  })

  it('lets an idle process exit after the idle period', async () => {
    respond = warmProcess()
    vi.useFakeTimers()
    const worker = new ArchitectureAnalysisWorker({ idleMs: 1_000 })
    await worker.analyze(pair, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(999)
    expect(clients[0]?.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(clients[0]?.dispose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    await worker.analyze(pair, new AbortController().signal)
    expect(clients).toHaveLength(2)
    worker.dispose()
  })

  it('refuses scans after disposal', async () => {
    const worker = new ArchitectureAnalysisWorker()
    worker.dispose()
    await expect(worker.analyze(pair, new AbortController().signal)).rejects.toThrow(
      /disposed/,
    )
    expect(clients).toHaveLength(0)
  })
})
