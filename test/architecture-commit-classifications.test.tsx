// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ArchitectureCommitClassifyRequest } from '../src/shared/architecture-review'
import {
  useCommitClassifications,
  type CommitClassificationState,
} from '../src/renderer/src/architecture-review/use-commit-classifications'

const revision = (n: number) => n.toString(16).padStart(40, '0')
const HEAD = revision(900)
const invoke = vi.fn()
let root = localPath('/repo')
let host: HTMLDivElement
let app: ReturnType<typeof createRoot>
const seen = new Map<string, CommitClassificationState>()

function Probe({
  name,
  revisions,
}: {
  readonly name: string
  readonly revisions: readonly string[]
}) {
  seen.set(name, useCommitClassifications(root, revisions))
  return <span>{name}</span>
}
function Head({ head }: { readonly head: string }) {
  useCommitClassifications(root, [], head)
  return null
}
const classifyCalls = () =>
  invoke.mock.calls
    .filter(([channel]) => channel === 'architecture-review:classify-commits')
    .map(([, request]) => (request as ArchitectureCommitClassifyRequest).revisions)
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

beforeEach(() => {
  root = localPath(`/repo-${Math.random().toString(16).slice(2)}`)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('hvir', { invoke, on: () => () => undefined })
  invoke.mockImplementation((_channel: string, request: unknown) => {
    const { revisions } = request as ArchitectureCommitClassifyRequest
    return Promise.resolve({
      head: HEAD,
      classifications: revisions.map((rev) => ({
        revision: rev,
        parent: null,
        merge: false,
        change: rev.endsWith('1') ? 'architecture' : 'code',
      })),
    })
  })
  host = document.createElement('div')
  document.body.append(host)
  app = createRoot(host)
})
afterEach(() => {
  act(() => app.unmount())
  host.remove()
  invoke.mockReset()
  seen.clear()
  vi.unstubAllGlobals()
})

it('shares one classification queue per workspace across History and the strip', async () => {
  const history = Array.from({ length: 70 }, (_, i) => revision(i))
  const strip = Array.from({ length: 30 }, (_, i) => revision(60 + i))
  act(() =>
    app.render(
      <>
        <Probe name="history" revisions={history} />
        <Probe name="strip" revisions={strip} />
      </>,
    ),
  )
  expect(seen.get('history')!.pending.size).toBe(90)
  await settle()
  await settle()
  expect(classifyCalls().map((batch) => batch.length)).toEqual([50, 40])
  expect(seen.get('history')!.known.size).toBe(90)
  expect(seen.get('strip')!.known.get(revision(65))).toBe('architecture')
  expect(seen.get('strip')!.known.get(revision(66))).toBe('code')
  expect(seen.get('history')!.pending.size).toBe(0)
  act(() => app.render(<Probe name="history" revisions={[revision(1), revision(95)]} />))
  await settle()
  expect(classifyCalls()).toHaveLength(3)
  expect(classifyCalls()[2]).toEqual([revision(95)])
})

it('reports a failed batch and retries it when the rows are asked for again', async () => {
  invoke.mockRejectedValueOnce(new Error('offline'))
  act(() => app.render(<Probe name="history" revisions={[revision(1)]} />))
  await settle()
  expect(seen.get('history')!.known.size).toBe(0)
  expect(seen.get('history')!.error).toBe('offline')
  act(() => app.render(<Probe name="history" revisions={[revision(1), revision(2)]} />))
  await settle()
  expect(classifyCalls()).toEqual([[revision(1)], [revision(1), revision(2)]])
  expect(seen.get('history')!.known.size).toBe(2)
  expect(seen.get('history')!.error).toBeUndefined()
})

it('drops answers from before HEAD moved and classifies the rows again', async () => {
  act(() =>
    app.render(
      <>
        <Head head={HEAD} />
        <Probe name="history" revisions={[revision(1), revision(2)]} />
      </>,
    ),
  )
  await settle()
  expect(seen.get('history')!.known.size).toBe(2)
  act(() =>
    app.render(
      <>
        <Head head={revision(901)} />
        <Probe name="history" revisions={[revision(1), revision(2)]} />
      </>,
    ),
  )
  expect(seen.get('history')!.known.size).toBe(0)
  await settle()
  expect(classifyCalls()).toHaveLength(2)
  expect(seen.get('history')!.known.size).toBe(2)
})
