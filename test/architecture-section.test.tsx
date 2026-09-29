// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArchitectureSection } from '../src/renderer/src/architecture-review/ArchitectureSection'

let host: HTMLDivElement
let app: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  app = createRoot(host)
})

afterEach(() => {
  act(() => app.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('collapses sections independently without unmounting their contents', () => {
  act(() =>
    app.render(
      <>
        <ArchitectureSection title="Architecture map">
          <div data-section="map" />
        </ArchitectureSection>
        <ArchitectureSection title="Captured evidence">
          <div data-section="evidence" />
        </ArchitectureSection>
      </>,
    ),
  )
  const sections = host.querySelectorAll<HTMLDetailsElement>('details')
  const map = sections[0]!
  const evidence = sections[1]!
  const mapContent = map.querySelector('[data-section="map"]')
  expect(map.open).toBe(true)
  expect(evidence.open).toBe(true)
  act(() => map.querySelector('summary')?.click())
  expect(map.open).toBe(false)
  expect(evidence.open).toBe(true)
  expect(map.querySelector('[data-section="map"]')).toBe(mapContent)
})
