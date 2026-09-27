// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ArchitectureCommitClassifyRequest } from '../src/shared/architecture-review'
import { useCommitClassifications } from '../src/renderer/src/architecture-review/use-commit-classifications'

const root = localPath('/repo')
const revision = (n: number) => n.toString(16).padStart(40, '0')
const invoke = vi.fn()
let host: HTMLDivElement
let app: ReturnType<typeof createRoot>
let seen: ReadonlyMap<string, string> = new Map()

function Probe({ revisions }: { readonly revisions: readonly string[] }) {
  seen = useCommitClassifications(root, revisions)
  return <span>{seen.size}</span>
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('hvir', { invoke, on: () => () => undefined })
  invoke.mockImplementation(async (_channel: string, request: unknown) => {
    const { revisions } = request as ArchitectureCommitClassifyRequest
    return revisions.map((rev) => ({
      revision: rev,
      parent: null,
      merge: false,
      change: rev.endsWith('1') ? 'architecture' : 'code',
    }))
  })
  host = document.createElement('div')
  document.body.append(host)
  app = createRoot(host)
})
afterEach(async () => {
  await act(async () => app.unmount())
  host.remove()
  invoke.mockReset()
  vi.unstubAllGlobals()
})

it('classifies requested commits in batches of at most fifty, once each', async () => {
  const revisions = Array.from({ length: 70 }, (_, i) => revision(i))
  await act(async () => app.render(<Probe revisions={revisions} />))
  await act(async () => undefined)
  const calls = invoke.mock.calls.filter(
    ([channel]) => channel === 'architecture-review:classify-commits',
  )
  expect(
    calls.map(
      ([, request]) => (request as ArchitectureCommitClassifyRequest).revisions.length,
    ),
  ).toEqual([50, 20])
  expect(seen.get(revision(1))).toBe('architecture')
  expect(seen.get(revision(2))).toBe('code')
  expect(seen.size).toBe(70)
  await act(async () => app.render(<Probe revisions={[revision(1), revision(71)]} />))
  await act(async () => undefined)
  const later = invoke.mock.calls
    .filter(([channel]) => channel === 'architecture-review:classify-commits')
    .map(([, request]) => (request as ArchitectureCommitClassifyRequest).revisions)
  expect(later).toHaveLength(3)
  expect(later[2]).toEqual([revision(71)])
})

it('leaves commits unmarked when classification fails', async () => {
  invoke.mockRejectedValue(new Error('offline'))
  await act(async () => app.render(<Probe revisions={[revision(1)]} />))
  await act(async () => undefined)
  expect(seen.size).toBe(0)
})
