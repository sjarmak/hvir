import { useId, useState, type ReactNode } from 'react'

export function ArchitectureSection({
  title,
  className,
  children,
}: {
  readonly title: string
  readonly className?: string
  readonly children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  const contentId = useId()
  return (
    <section className={`architecture-review-section${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="architecture-review-section-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      <div id={contentId} className="architecture-review-section-content" hidden={!open}>
        {children}
      </div>
    </section>
  )
}
