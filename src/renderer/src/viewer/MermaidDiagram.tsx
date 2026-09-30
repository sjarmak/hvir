import { useEffect, useRef, useState } from 'react'
import { useAppTheme } from '../theme'
import { renderMermaid } from './mermaid-renderer'

const MIN_ZOOM = 50
const MAX_ZOOM = 200
const ZOOM_STEP = 25

export function MermaidDiagram({
  source,
  className,
}: {
  readonly source: string
  readonly className: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const theme = useAppTheme()
  const [zoom, setZoom] = useState(100)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  useEffect(() => {
    const element = root.current
    if (!element) return
    let cancelled = false
    element.textContent = 'Rendering diagram…'
    void renderMermaid(source, theme).then(
      (svg) => {
        if (!cancelled) {
          element.innerHTML = svg
          applyDiagramZoom(element, zoomRef.current)
        }
      },
      (error: unknown) => {
        if (!cancelled)
          element.textContent = error instanceof Error ? error.message : String(error)
      },
    )
    return () => {
      cancelled = true
    }
  }, [source, theme])
  useEffect(() => {
    if (root.current) applyDiagramZoom(root.current, zoom)
  }, [zoom, source, theme])
  return (
    <div className={className}>
      <div className="mermaid-diagram-controls" aria-label="Diagram zoom">
        <button
          type="button"
          aria-label="Zoom out diagram"
          disabled={zoom === MIN_ZOOM}
          onClick={() => setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP))}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Reset diagram zoom"
          disabled={zoom === 100}
          onClick={() => setZoom(100)}
        >
          {zoom}%
        </button>
        <button
          type="button"
          aria-label="Zoom in diagram"
          disabled={zoom === MAX_ZOOM}
          onClick={() => setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP))}
        >
          +
        </button>
      </div>
      <div className="mermaid-diagram-viewport" ref={root} />
    </div>
  )
}

function applyDiagramZoom(root: HTMLElement, zoom: number): void {
  const svg = root.querySelector('svg')
  if (svg) svg.style.width = `${zoom}%`
}
