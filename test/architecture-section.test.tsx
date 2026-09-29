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
  const sections = host.querySelectorAll<HTMLElement>('.architecture-review-section')
  const map = sections[0]!
  const evidence = sections[1]!
  const mapContent = map.querySelector('[data-section="map"]')
  const mapToggle = map.querySelector<HTMLButtonElement>('button')!
  const evidenceToggle = evidence.querySelector<HTMLButtonElement>('button')!
  expect(mapToggle.getAttribute('aria-expanded')).toBe('true')
  expect(evidenceToggle.getAttribute('aria-expanded')).toBe('true')
  expect(
    map.querySelector<HTMLElement>('.architecture-review-section-content')?.hidden,
  ).toBe(false)
  act(() => mapToggle.click())
  expect(mapToggle.getAttribute('aria-expanded')).toBe('false')
  expect(evidenceToggle.getAttribute('aria-expanded')).toBe('true')
  expect(
    map.querySelector<HTMLElement>('.architecture-review-section-content')?.hidden,
  ).toBe(true)
  expect(map.querySelector('[data-section="map"]')).toBe(mapContent)
})
