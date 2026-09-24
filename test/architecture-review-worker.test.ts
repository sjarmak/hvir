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

import { analyzeInWorker } from '../src/main/architecture-review/worker'
import { analyzeCaptureTimed } from '../src/main/architecture-review/timed-analysis'
import {
  ArchitectureScanRecorder,
  epochClock,
} from '../src/main/architecture-review/scan-recorder'
import { localPath } from '../src/shared/host-path'
import { expectMonotoneMetrics, stagesOf } from './architecture-scan-metrics-fixture'

const capture = {} as ArchitectureCapture

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
  it('places spawn, transfer, parse, compare and return spans on the scan timeline', async () => {
    const pair: ArchitectureCapture = {
      root: localPath('/repo'),
      mode: 'head',
      baselineRevision: 'b',
      currentRevision: 'c',
      fingerprint: 'f',
      before: [{ path: 'a.ts', content: 'export {}' }],
      after: [{ path: 'a.ts', content: "import './b'" }],
      exclusions: [],
      capturedAt: 'now',
    }
    respond = (payload) => {
      const readyEpochMs = epochClock()
      const receivedEpochMs = epochClock()
      const timed = analyzeCaptureTimed(payload as ArchitectureCapture)
      return Promise.resolve({
        analysis: timed.analysis,
        timings: {
          readyEpochMs,
          receivedEpochMs,
          respondedEpochMs: epochClock(),
          resultBytes: 321,
          stages: timed.stages,
        },
      })
    }
    const recorder = new ArchitectureScanRecorder()
    const analysis = await analyzeInWorker(pair, new AbortController().signal, recorder)
    expect(analysis.modules.map((module) => module.path)).toEqual(['a.ts'])
    const metrics = recorder.metrics()
    expectMonotoneMetrics(metrics)
    expect(stagesOf(metrics)).toEqual([
      'compare',
      'parse',
      'worker-return',
      'worker-spawn',
      'worker-transfer',
    ])
    expect(metrics.spans.find((span) => span.stage === 'worker-transfer')).toMatchObject({
      bytes: 'a.ts'.length * 2 + 'export {}'.length + "import './b'".length,
      items: 2,
    })
    expect(metrics.spans.find((span) => span.stage === 'worker-return')).toMatchObject({
      bytes: 321,
    })
  })

  it('rejects malformed worker timings rather than recording them', async () => {
    respond = () =>
      Promise.resolve({
        analysis: { modules: [] },
        timings: { readyEpochMs: 'soon', stages: [] },
      })
    await expect(
      analyzeInWorker(
        { ...capture, before: [], after: [] },
        new AbortController().signal,
        new ArchitectureScanRecorder(),
      ),
    ).rejects.toThrow(/timings/)
  })
})
