import { expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type {
  ArchitectureCommitClassifyRequest,
  ArchitectureCommitClassifyResult,
} from '../src/shared/architecture-review'
import {
  CommitClassificationStore,
  type ClassifyInvoke,
} from '../src/renderer/src/architecture-review/commit-classification-store'

const root = localPath('/repo')
const revision = (n: number) => n.toString(16).padStart(40, '0')
const revisions = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => revision(from + i))
const HEAD = revision(900)

type Settle = {
  readonly request: ArchitectureCommitClassifyRequest
  readonly resolve: (result: ArchitectureCommitClassifyResult) => void
  readonly reject: (error: Error) => void
}
function manualInvoke() {
  const calls: Settle[] = []
  const invoke = vi.fn<ClassifyInvoke>(
    (request) =>
      new Promise((resolve, reject) => {
        calls.push({ request, resolve, reject })
      }),
  )
  const answer = (call: Settle, head = HEAD) =>
    call.resolve({
      head,
      classifications: call.request.revisions.map((rev) => ({
        revision: rev,
        parent: null,
        merge: false,
        change: rev.endsWith('1') ? 'architecture' : 'code',
      })),
    })
  return { calls, invoke, answer }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

it('classifies in batches of at most fifty, one request in flight per workspace', async () => {
  const git = manualInvoke()
  const store = new CommitClassificationStore(root, git.invoke)
  const seen: number[] = []
  store.subscribe(() => seen.push(store.read().known.size))
  store.request(revisions(0, 70))
  store.request(revisions(60, 80))
  expect(git.calls).toHaveLength(1)
  expect(git.calls[0]!.request.revisions).toHaveLength(50)
  expect(store.read().pending.size).toBe(80)
  git.answer(git.calls[0]!)
  await flush()
  expect(git.calls).toHaveLength(2)
  expect(git.calls[1]!.request.revisions).toEqual(revisions(50, 80))
  git.answer(git.calls[1]!)
  await flush()
  expect(git.calls).toHaveLength(2)
  expect(store.read().known.size).toBe(80)
  expect(store.read().known.get(revision(1))).toBe('architecture')
  expect(store.read().pending.size).toBe(0)
  expect(seen.filter((size) => size > 0)).toEqual([50, 80])
  store.request(revisions(0, 80))
  expect(git.calls).toHaveLength(2)
})

it('reports a failed batch, keeps draining and retries the failed commits on the next request', async () => {
  const git = manualInvoke()
  const store = new CommitClassificationStore(root, git.invoke)
  store.request(revisions(0, 120))
  git.answer(git.calls[0]!)
  await flush()
  git.calls[1]!.reject(new Error('offline'))
  await flush()
  expect(store.read().error).toBe('offline')
  expect(git.calls).toHaveLength(3)
  git.answer(git.calls[2]!)
  await flush()
  expect(store.read().known.size).toBe(70)
  expect(store.read().pending.size).toBe(0)
  expect(store.read().error).toBe('offline')
  store.request(revisions(0, 120))
  expect(git.calls).toHaveLength(4)
  expect(git.calls[3]!.request.revisions).toEqual(revisions(50, 100))
  git.answer(git.calls[3]!)
  await flush()
  expect(store.read().known.size).toBe(120)
  expect(store.read().error).toBeUndefined()
})

it('drops answers computed before HEAD moved and classifies again', async () => {
  const git = manualInvoke()
  const store = new CommitClassificationStore(root, git.invoke)
  store.request(revisions(0, 10))
  git.answer(git.calls[0]!)
  await flush()
  expect(store.read().known.size).toBe(10)
  store.request(revisions(10, 20))
  store.invalidate(revision(901))
  expect(store.read().known.size).toBe(0)
  expect(store.read().pending.size).toBe(0)
  git.answer(git.calls[1]!)
  await flush()
  expect(store.read().known.size).toBe(0)
  store.request(revisions(0, 20))
  expect(git.calls).toHaveLength(3)
  git.answer(git.calls[2]!, revision(901))
  await flush()
  expect(store.read().known.size).toBe(20)
  store.invalidate(revision(901))
  expect(store.read().known.size).toBe(20)
})

it('starts over when a response reports a different HEAD than the answers it holds', async () => {
  const git = manualInvoke()
  const store = new CommitClassificationStore(root, git.invoke)
  store.request(revisions(0, 10))
  git.answer(git.calls[0]!)
  await flush()
  store.request(revisions(10, 20))
  git.answer(git.calls[1]!, revision(902))
  await flush()
  expect([...store.read().known.keys()]).toEqual(revisions(10, 20))
  expect(store.read().head).toBe(revision(902))
})
