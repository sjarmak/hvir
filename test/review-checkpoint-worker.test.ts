import { afterEach, expect, it, vi } from 'vitest'
import {
  GIT_REVIEW_CHECKPOINT_TYPE,
  localPath,
  type WorkerHostCall,
  type WorkerHostResult,
  type WorkerRequest,
  type WorkerResponse,
} from '../src/shared'

const original = Object.getOwnPropertyDescriptor(process, 'parentPort')

afterEach(() => {
  if (original) Object.defineProperty(process, 'parentPort', original)
  else Reflect.deleteProperty(process, 'parentPort')
  vi.resetModules()
})

async function fixture() {
  let receive!: (event: { data: WorkerRequest | WorkerHostResult }) => void
  const messages: (WorkerHostCall | WorkerResponse)[] = []
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: (_event: string, callback: typeof receive) => {
        receive = callback
      },
      postMessage: (message: WorkerHostCall | WorkerResponse) => {
        messages.push(message)
      },
    },
  })
  await import('../src/workers/git-worker')
  return { messages, send: (data: WorkerRequest | WorkerHostResult) => receive({ data }) }
}

it('carries the main-owned checkpoint grant through the worker host bridge', async () => {
  const { messages, send } = await fixture()
  const root = localPath('/workspace')
  send({
    id: 1,
    type: GIT_REVIEW_CHECKPOINT_TYPE,
    payload: { root, action: 'status', operationId: 'main-grant' },
  })
  await vi.waitFor(() => expect(messages[0]).toMatchObject({ kind: 'host-call' }))
  const call = messages[0] as WorkerHostCall
  expect(call).toMatchObject({
    operation: 'reviewCheckpoint',
    operationId: 'main-grant',
    hostId: root.hostId,
    path: root,
    request: { action: 'inspect' },
  })
  send({
    kind: 'host-result',
    callId: call.callId,
    ok: true,
    result: { root, oid: null, objectFormat: 'sha1' },
  })
  await vi.waitFor(() =>
    expect(messages[1]).toEqual({
      id: 1,
      ok: true,
      result: { root, oid: null, changes: [] },
    }),
  )
})

it('rejects checkpoint work without a grant before any host IO', async () => {
  const { messages, send } = await fixture()
  send({
    id: 2,
    type: GIT_REVIEW_CHECKPOINT_TYPE,
    payload: { root: localPath('/workspace'), action: 'capture' },
  })
  await vi.waitFor(() => expect(messages).toHaveLength(1))
  expect(messages[0]).toMatchObject({ id: 2, ok: false })
  const response = messages[0] as WorkerResponse
  expect('error' in response && response.error).toContain('checkpoint')
})
