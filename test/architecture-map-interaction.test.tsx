// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArchitectureMap } from '../src/renderer/src/architecture-review/ArchitectureMap'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'

vi.mock('../src/renderer/src/architecture-review/architecture-layout-client', () => ({
  requestArchitectureLayout: () => new Promise(() => undefined),
}))

const before = {
  scope: '.',
  exclusions: [],
  files: [
    { path: 'ui/a.ts', content: 'import "../data/a";\nimport "../data/old"' },
    { path: 'data/a.ts', content: '' },
    { path: 'data/old.ts', content: '' },
  ],
}
const analysis = analyzeArchitecture(before, {
  ...before,
  files: [
    { path: 'ui/a.ts', content: '\n\nimport "../data/a";\nimport "../data/new"' },
    { path: 'data/a.ts', content: '' },
    { path: 'data/new.ts', content: '' },
  ],
})
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
it('keeps subsystem positions and opens exact side-specific import evidence', () => {
  const evidence = vi.fn()
  const render = (mode: 'before' | 'after') =>
    act(() =>
      root.render(
        <ArchitectureMap
          analysis={analysis}
          mode={mode}
          onMode={() => undefined}
          onEvidence={evidence}
        />,
      ),
    )
  render('before')
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        '.architecture-file-explorer .architecture-module',
      )!
      .click(),
  )
  expect(evidence.mock.calls.at(-1)?.[2]).toBe('before')
  const positions = Array.from(
    container.querySelectorAll<HTMLElement>('.architecture-canvas-node'),
  ).map((n) => n.style.cssText)
  let buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>('.architecture-relationship button'),
  )
  expect(buttons.map((b) => b.textContent?.includes('../data/new'))).not.toContain(true)
  act(() => buttons.find((b) => b.textContent?.includes('../data/a'))!.click())
  expect(evidence).toHaveBeenLastCalledWith('ui/a.ts', 1, 'before')
  act(() => buttons.find((b) => b.textContent?.includes('../data/old'))!.click())
  expect(evidence).toHaveBeenLastCalledWith('ui/a.ts', 2, 'before')
  render('after')
  expect(
    Array.from(container.querySelectorAll<HTMLElement>('.architecture-canvas-node')).map(
      (n) => n.style.cssText,
    ),
  ).toEqual(positions)
  buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>('.architecture-relationship button'),
  )
  expect(buttons.map((b) => b.textContent?.includes('../data/old'))).not.toContain(true)
  act(() => buttons.find((b) => b.textContent?.includes('../data/a'))!.click())
  expect(evidence).toHaveBeenLastCalledWith('ui/a.ts', 3, 'after')
})

it('offers an expanded map and makes file status scannable without color', () => {
  act(() =>
    root.render(
      <ArchitectureMap
        analysis={analysis}
        mode="overlay"
        onMode={() => undefined}
        onEvidence={() => undefined}
      />,
    ),
  )

  const map = container.querySelector<HTMLElement>('.architecture-review-map')!
  const expand = container.querySelector<HTMLButtonElement>(
    '[aria-label="Expand architecture map"]',
  )!
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  expect(map.classList.contains('architecture-map-expanded')).toBe(false)

  act(() => expand.click())
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  expect(map.classList.contains('architecture-map-expanded')).toBe(true)
  expect(expand.textContent).toContain('Collapse map')

  const files = container.querySelector('.architecture-file-explorer')!
  expect(files.querySelector('.architecture-file-group.changed')).not.toBeNull()
  expect(files.querySelector('.architecture-file-group.unchanged')).not.toBeNull()
  expect(
    files.querySelector('.architecture-module.change-added small')?.textContent,
  ).toBe('Added')
  expect(
    files.querySelector('.architecture-module.change-unchanged small')?.textContent,
  ).toBe('Unchanged')

  const explorer = files as HTMLDetailsElement
  explorer.open = true
  act(() => explorer.querySelector<HTMLButtonElement>('.architecture-module')!.click())
  expect(map.classList.contains('architecture-map-expanded')).toBe(false)
})

it('expands subsystem modules in the canvas and preserves relationship evidence', () => {
  const evidence = vi.fn()
  act(() =>
    root.render(
      <ArchitectureMap
        analysis={analysis}
        mode="overlay"
        onMode={() => undefined}
        onEvidence={evidence}
      />,
    ),
  )
  const subsystem = container.querySelector<HTMLElement>(
    '[aria-label^="subsystem data"]',
  )!
  act(() => subsystem.click())
  expect(container.querySelectorAll('.architecture-canvas-module')).toHaveLength(3)
  act(() =>
    container.querySelector<HTMLElement>('[aria-label^="module data/old.ts"]')!.click(),
  )
  expect(evidence).toHaveBeenLastCalledWith('data/old.ts', 1, 'before')
  const relationships = container.querySelector('[aria-label="Subsystem relationships"]')!
  expect(relationships.querySelector('h3')?.textContent).toBe(
    'Subsystem relationships involving data',
  )
  const relationship = relationships.querySelector('.architecture-relationship')!
  expect(relationship.querySelector('summary')?.textContent).toContain('ui → data')
  const module = relationship.querySelector('[aria-label="Imports in ui/a.ts"]')!
  expect(module.querySelector('h4')?.textContent).toContain('ui/a.ts')
  expect(module.querySelectorAll('button')).toHaveLength(3)
  const later = relationships.compareDocumentPosition(
    container.querySelector('.architecture-file-explorer')!,
  )
  expect(later & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
