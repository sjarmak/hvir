// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { localPath, type HostPath } from '../src/shared'
import { useArchitectureReviewTab } from '../src/renderer/src/architecture-review/use-architecture-review-tab'

vi.mock('../src/renderer/src/architecture-review/ArchitectureReview', () => ({
  ArchitectureReview: () => <span>review</span>,
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
    return tab.panel(path, 'primary', () => Promise.resolve())
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
    expect(container.textContent).toBe('review')
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
afterEach(() => vi.restoreAllMocks())
