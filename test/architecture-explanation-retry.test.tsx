// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ArchitectureReviewSnapshot } from '../src/shared/architecture-review'
import { ArchitectureExplanation } from '../src/renderer/src/architecture-review/ArchitectureExplanation'
import { MermaidDiagram } from '../src/renderer/src/viewer/MermaidDiagram'

const root = localPath('/repo')
const snapshot = { id: 'snapshot' } as ArchitectureReviewSnapshot
const invoke = vi.fn<(channel: string, request?: unknown) => Promise<unknown>>()
const send = vi.fn()
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
    if (channel === 'mermaid:render')
      return Promise.resolve(
        '<svg xmlns="http://www.w3.org/2000/svg" aria-label="Rendered sequence"></svg>',
      )
    return Promise.reject(new Error('Model unavailable'))
  })
  vi.stubGlobal('hvir', {
    invoke,
    send,
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
  expect(invoke).toHaveBeenCalledWith(
    'mermaid:render',
    expect.objectContaining({
      source: 'sequenceDiagram\n  User->>hvir: Explain',
      theme: 'dark',
    }),
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

it('shows Mermaid rendering errors', async () => {
  invoke.mockRejectedValue(new Error('Invalid diagram'))

  await act(async () => {
    app.render(<MermaidDiagram source="invalid" className="diagram" />)
    await Promise.resolve()
  })

  await vi.waitFor(() => expect(host.textContent).toContain('Invalid diagram'))
})

it('cancels a replaced diagram without mounting its late result', async () => {
  let finishFirst!: (svg: string) => void
  let finishSecond!: (svg: string) => void
  invoke.mockImplementation((channel) => {
    if (channel !== 'mermaid:render') return Promise.reject(new Error('Unexpected call'))
    return new Promise<string>((resolve) => {
      if (!finishFirst) finishFirst = resolve
      else finishSecond = resolve
    })
  })

  await act(async () => {
    app.render(
      <MermaidDiagram source="sequenceDiagram\n  A->>B: First" className="diagram" />,
    )
    await Promise.resolve()
  })
  const firstRequest = invoke.mock.calls[0]![1] as { id: string }
  await act(async () => {
    app.render(
      <MermaidDiagram source="sequenceDiagram\n  A->>B: Second" className="diagram" />,
    )
    await Promise.resolve()
  })
  expect(send).toHaveBeenCalledWith('mermaid:cancel', { id: firstRequest.id })

  await act(async () => {
    finishFirst('<svg xmlns="http://www.w3.org/2000/svg"><text>stale</text></svg>')
    finishSecond('<svg xmlns="http://www.w3.org/2000/svg"><text>latest</text></svg>')
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(host.textContent).toContain('latest'))
  expect(host.textContent).not.toContain('stale')
})
