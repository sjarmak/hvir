// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ArchitectureReviewSnapshot } from '../src/shared/architecture-review'
import { ArchitectureExplanation } from '../src/renderer/src/architecture-review/ArchitectureExplanation'

const root = localPath('/repo')
const snapshot = { id: 'snapshot' } as ArchitectureReviewSnapshot
const invoke = vi.fn<(channel: string) => Promise<unknown>>()
let host: HTMLDivElement
let app: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockImplementation((channel) => {
    if (channel === 'harness:catalog')
      return Promise.resolve([{ id: 'claude-code', architectureExplanation: true }])
    if (channel === 'harness:profiles')
      return Promise.resolve([
        {
          id: 'native',
          providerId: 'claude-code',
          displayName: 'Claude Code',
          launchRevision: 3,
          executable: { kind: 'provider-default' },
          args: [],
        },
      ])
    if (channel === 'architecture-review:explanation')
      return Promise.resolve({
        status: 'ready',
        explanation: {
          snapshotId: snapshot.id,
          claim: {
            version: 1,
            snapshotId: snapshot.id,
            whatChanged: 'The previous claim remains visible.',
            why: 'The failed attempt did not replace it.',
            sequenceDiagram: 'sequenceDiagram\n  User->>hvir: Explain',
            touched: { systems: [], subsystems: [], modules: [] },
          },
          names: { systems: [], subsystems: [], modules: [] },
        },
      })
    return Promise.reject(new Error('Model unavailable'))
  })
  vi.stubGlobal('hvir', { invoke, on: vi.fn() })
  host = document.createElement('div')
  document.body.append(host)
  app = createRoot(host)
})

afterEach(() => {
  act(() => app.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('restores the prior claim when regeneration fails', async () => {
  await act(async () => {
    app.render(
      <ArchitectureExplanation
        root={root}
        reviewId="review"
        snapshot={snapshot}
        collapsed={false}
        onCollapsedChange={vi.fn()}
      />,
    )
    await Promise.resolve()
  })
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === 'Explain this change',
  )!
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
  expect(host.textContent).toContain('The previous claim remains visible.')
  expect(host.textContent).toContain('Model unavailable')
  expect(host.textContent).not.toContain('Waiting for the agent claim')
})
