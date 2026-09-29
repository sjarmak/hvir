import { useState, type ReactNode } from 'react'

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
  return (
    <details
      className={`architecture-review-section${className ? ` ${className}` : ''}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      <div className="architecture-review-section-content">{children}</div>
    </details>
  )
}
