import { expect, it, vi } from 'vitest'
import type { ArchitectureCapture } from '../src/shared/architecture-review'

const requests: unknown[] = []
vi.mock('../src/main/worker-host', () => ({
  createWorkerClient: vi.fn(() => ({
    dispose: vi.fn(),
    request: vi.fn((_type: string, payload: unknown) => {
      requests.push(payload)
      return Promise.resolve({ analysis: { modules: [] }, timings: {} })
    }),
  })),
  workerPath: vi.fn(() => '/tmp/architecture-worker.js'),
}))

vi.mock('../src/main/application-runtime', () => ({
  applicationUserDataPath: (name: string) => `/home/person/.config/hvir/${name}`,
}))

import { createArchitectureReview } from '../src/main/architecture-review/runtime'
import { ARCHITECTURE_PARSE_CACHE_BYTES } from '../src/main/architecture-review/module-facts-cache'
import { ArchitectureAnalysisWorker } from '../src/main/architecture-review/worker'
import { ArchitectureReviewCoordinator } from '../src/main/architecture-review/coordinator'
import type { RendererResourceScopes } from '../src/main/renderer-resource-scopes'

it('keeps the parse cache under userData and owns the warm worker for disposal', async () => {
  const owned: {
    label: string
    resource: unknown
    dispose: (value: never) => unknown
  }[] = []
  const runtime = {
    own: <T>(label: string, resource: T, dispose: (value: T) => unknown): T => {
      owned.push({ label, resource, dispose })
      return resource
    },
  }
  const review = createArchitectureReview({} as RendererResourceScopes, runtime)
  expect(review).toBeInstanceOf(ArchitectureReviewCoordinator)
  const worker = owned.find(
    (entry) => entry.resource instanceof ArchitectureAnalysisWorker,
  )
  expect(worker?.label).toBe('architecture analysis worker')
  const analyze = (worker!.resource as ArchitectureAnalysisWorker).analyze
  await analyze(
    {
      before: [],
      after: [],
      configs: { before: [], after: [] },
    } as unknown as ArchitectureCapture,
    new AbortController().signal,
  )
  expect(requests[0]).toMatchObject({
    cache: {
      directory: '/home/person/.config/hvir/architecture-parse-cache',
      maxBytes: ARCHITECTURE_PARSE_CACHE_BYTES,
    },
  })
  expect(owned.map((entry) => entry.label)).toEqual([
    'architecture analysis worker',
    'architecture review',
  ])
})
