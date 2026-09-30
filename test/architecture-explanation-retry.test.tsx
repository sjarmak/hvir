// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ArchitectureReviewSnapshot } from '../src/shared/architecture-review'
import { ArchitectureExplanation } from '../src/renderer/src/architecture-review/ArchitectureExplanation'
import { MermaidDiagram } from '../src/renderer/src/viewer/MermaidDiagram'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(() =>
    Promise.resolve({ svg: '<svg aria-label="Rendered sequence"></svg>' }),
  ),
}))

vi.mock('mermaid', () => ({ default: mermaid }))

const root = localPath('/repo')
const snapshot = { id: 'snapshot' } as ArchitectureReviewSnapshot
const invoke = vi.fn<(channel: string) => Promise<unknown>>()
let progress: ((payload: unknown) => void) | undefined
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
  vi.stubGlobal('hvir', {
    invoke,
    on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
      if (channel === 'architecture-review:explanation-progress') progress = handler
      return () => undefined
    }),
  })
  host = document.createElement('div')
  document.body.append(host)
  app = createRoot(host)
})

it('renders model output before the final explanation resolves', async () => {
  let resolveExplanation!: (value: unknown) => void
  invoke.mockImplementation((channel) => {
    if (channel === 'harness:catalog')
      return Promise.resolve([{ id: 'claude-code', architectureExplanation: true }])
    if (channel === 'harness:profiles')
      return Promise.resolve([
        {
          id: 'native',
          providerId: 'claude-code',
          displayName: 'Claude Code',
          launchRevision: 4,
          executable: { kind: 'provider-default' },
          args: [],
        },
      ])
    if (channel === 'architecture-review:explanation') return Promise.resolve(null)
    return new Promise((resolve) => {
      resolveExplanation = resolve
    })
  })
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
    progress?.({
      root,
      reviewId: 'review',
      snapshotId: snapshot.id,
      state: { status: 'waiting', snapshotId: snapshot.id, output: '{"version":1' },
    })
  })
  expect(host.textContent).toContain('{"version":1')
  await act(async () => {
    resolveExplanation({ status: 'invalid', snapshotId: snapshot.id, message: 'done' })
    await Promise.resolve()
  })
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

it('renders the sequence claim as a Mermaid diagram', async () => {
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
  await vi.waitFor(() => {
    expect(host.querySelector('.architecture-explanation-diagram svg')).not.toBeNull()
  })
  expect(host.querySelector('.architecture-explanation-claim pre')).toBeNull()
  expect(mermaid.render).toHaveBeenCalledWith(
    expect.stringMatching(/^mermaid-/),
    'sequenceDiagram\n  User->>hvir: Explain',
  )
  const diagram = host.querySelector<HTMLElement>('.architecture-explanation-diagram')!
  const svg = diagram.querySelector<SVGElement>('svg')!
  expect(diagram.querySelector('[aria-label="Diagram zoom"]')).not.toBeNull()
  expect(diagram.textContent).toContain('100%')
  act(() =>
    diagram.querySelector<HTMLButtonElement>('[aria-label="Zoom in diagram"]')!.click(),
  )
  expect(svg.style.width).toBe('125%')
  expect(diagram.textContent).toContain('125%')
  act(() =>
    diagram
      .querySelector<HTMLButtonElement>('[aria-label="Reset diagram zoom"]')!
      .click(),
  )
  expect(svg.style.width).toBe('100%')
})

it('keeps the selected zoom when the diagram source changes', async () => {
  await act(async () => {
    app.render(
      <MermaidDiagram source="sequenceDiagram\n  A->>B: First" className="diagram" />,
    )
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(host.querySelector('.diagram svg')).not.toBeNull())
  act(() =>
    host.querySelector<HTMLButtonElement>('[aria-label="Zoom in diagram"]')!.click(),
  )

  await act(async () => {
    app.render(
      <MermaidDiagram source="sequenceDiagram\n  A->>B: Second" className="diagram" />,
    )
    await Promise.resolve()
  })
  await vi.waitFor(() => {
    expect(host.querySelector<SVGElement>('.diagram svg')?.style.width).toBe('125%')
  })
})
