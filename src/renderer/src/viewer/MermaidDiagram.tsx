import { useEffect, useRef } from 'react'
import { useAppTheme } from '../theme'
import { renderMermaid } from './mermaid-renderer'

export function MermaidDiagram({
  source,
  className,
}: {
  readonly source: string
  readonly className: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const theme = useAppTheme()
  useEffect(() => {
    const element = root.current
    if (!element) return
    let cancelled = false
    element.textContent = 'Rendering diagram…'
    void renderMermaid(source, theme).then(
      (svg) => {
        if (!cancelled) element.innerHTML = svg
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
  return <div className={className} ref={root} />
}
