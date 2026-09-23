import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArchitectureCapture } from '../src/shared/architecture-review'

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
    const request = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
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

const capture = {} as ArchitectureCapture

afterEach(() => {
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
