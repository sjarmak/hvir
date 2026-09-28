// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArchitectureRelationships } from '../src/renderer/src/architecture-review/ArchitectureRelationships'
import type { ArchitectureRelationshipDelta } from '../src/shared/architecture-analysis'

const relationships: readonly ArchitectureRelationshipDelta[] = [
  { source: 'ui', target: 'data', before: 2, after: 2, change: 'changed', evidence: [] },
  { source: 'ui', target: 'auth', before: 0, after: 1, change: 'added', evidence: [] },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('opens exactly the relationship matching an edge click, not every relationship', () => {
  act(() =>
    root.render(
      <ArchitectureRelationships
        relationships={relationships}
        mode="overlay"
        onEvidence={() => undefined}
        focused={{ source: 'ui', target: 'data' }}
      />,
    ),
  )
  const details = Array.from(
    container.querySelectorAll<HTMLDetailsElement>('.architecture-relationship'),
  )
  expect(details.map((d) => d.open)).toEqual([true, false])
  expect(details[0]?.classList.contains('architecture-relationship-focused')).toBe(true)
  expect(details[1]?.classList.contains('architecture-relationship-focused')).toBe(false)
})

it('leaves every relationship closed when nothing is focused', () => {
  act(() =>
    root.render(
      <ArchitectureRelationships
        relationships={relationships}
        mode="overlay"
        onEvidence={() => undefined}
      />,
    ),
  )
  const details = Array.from(
    container.querySelectorAll<HTMLDetailsElement>('.architecture-relationship'),
  )
  expect(details.map((d) => d.open)).toEqual([false, false])
})
