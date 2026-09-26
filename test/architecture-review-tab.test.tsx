// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { localPath, type HostPath } from '../src/shared'
import { useArchitectureReviewTab } from '../src/renderer/src/architecture-review/use-architecture-review-tab'

vi.mock('../src/renderer/src/architecture-review/ArchitectureReview', () => ({
  ArchitectureReview: () => <button type="button">Scan snapshot</button>,
}))
it('retains an inactive review, deactivates for files, and never exposes it in another workspace', () => {
  const container = document.createElement('div')
  const app = createRoot(container)
  let tab!: ReturnType<typeof useArchitectureReviewTab>
  const activateViewer = vi.fn()
  function Harness({ path }: { path: HostPath }) {
    const root = useRef<HostPath | undefined>(path)
    root.current = path
    tab = useArchitectureReviewTab({ root, activateViewer })
    return (
      <section
        onPointerDownCapture={() => {
          if (tab.handlesPointerActivation(path, 'primary')) return
          tab.deactivate()
        }}
      >
        {tab.panel(path, 'primary', () => Promise.resolve())}
      </section>
    )
  }
  const path = localPath('/one')
  try {
    act(() => app.render(<Harness path={path} />))
    act(() => tab.open())
    expect(activateViewer).toHaveBeenCalledOnce()
    expect(tab.active(path)).toBe(true)
    expect(tab.active(path, 'secondary')).toBe(false)
    act(() => tab.deactivate())
    expect(tab.active(path)).toBe(false)
    expect(container.textContent).toBe('Scan snapshot')
    act(() => app.render(<Harness path={localPath('/two')} />))
    expect(container.textContent).toBe('')
    expect(tab.stripProps(localPath('/two'), 'primary').architectureReviewOpen).toBe(
      false,
    )
    act(() => tab.close())
    expect(tab.stripProps(path, 'primary').architectureReviewOpen).toBe(false)
  } finally {
    act(() => app.unmount())
  }
})
it('keeps the review active when its scan control activates the viewer pane', () => {
  const container = document.createElement('div')
  const app = createRoot(container)
  let tab!: ReturnType<typeof useArchitectureReviewTab>
  const path = localPath('/one')
  function Harness() {
    const root = useRef<HostPath | undefined>(path)
    tab = useArchitectureReviewTab({ root, activateViewer: vi.fn() })
    return (
      <section
        onPointerDownCapture={() => {
          if (tab.handlesPointerActivation(path, 'primary')) return
          tab.deactivate()
        }}
      >
        {tab.panel(path, 'primary', () => Promise.resolve())}
      </section>
    )
  }
  try {
    act(() => app.render(<Harness />))
    act(() => tab.open())
    act(() => {
      container
        .querySelector('button')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect(tab.active(path)).toBe(true)
    expect(container.textContent).toBe('Scan snapshot')
  } finally {
    act(() => app.unmount())
  }
})
afterEach(() => vi.restoreAllMocks())
