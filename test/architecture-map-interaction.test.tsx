// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArchitectureMap } from '../src/renderer/src/architecture-review/ArchitectureMap'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'
import { requestArchitectureLayout } from '../src/renderer/src/architecture-review/architecture-layout-client'
import { ARCHITECTURE_MODULE_CAP } from '../src/renderer/src/architecture-review/architecture-review-model'

vi.mock('../src/renderer/src/architecture-review/architecture-layout-client', () => ({
  requestArchitectureLayout: vi.fn(() => new Promise(() => undefined)),
}))

const before = {
  scope: '.',
  exclusions: [],
  files: [
    { path: 'ui/a.ts', content: 'import "../data/a";\nimport "../data/old"' },
    { path: 'data/a.ts', content: '' },
    { path: 'data/old.ts', content: '' },
    { path: 'data/spare.ts', content: '' },
  ],
}
const analysis = analyzeArchitecture(before, {
  ...before,
  files: [
    { path: 'ui/a.ts', content: '\n\nimport "../data/a";\nimport "../data/new"' },
    { path: 'data/a.ts', content: '' },
    { path: 'data/new.ts', content: '' },
    { path: 'data/spare.ts', content: '' },
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
  vi.mocked(requestArchitectureLayout).mockClear()
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
  expect(expand.textContent).toBe('+')
  expect(map.classList.contains('architecture-map-expanded')).toBe(false)

  act(() => expand.click())
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  expect(map.classList.contains('architecture-map-expanded')).toBe(true)
  expect(expand.textContent).toBe('−')
  const canvas = container.querySelector('.react-flow')
  act(() => expand.click())
  expect(expand.textContent).toBe('+')
  expect(map.classList.contains('architecture-map-expanded')).toBe(false)
  expect(container.querySelector('.react-flow')).toBe(canvas)
  act(() => expand.click())

  const files = container.querySelector('.architecture-file-explorer')!
  const changedFiles = files.querySelector<HTMLDetailsElement>(
    '.architecture-file-group.changed',
  )!
  const unchangedFiles = files.querySelector<HTMLDetailsElement>(
    '.architecture-file-group.unchanged',
  )!
  expect(changedFiles.open).toBe(true)
  expect(unchangedFiles.open).toBe(false)
  expect(unchangedFiles.querySelector('summary')?.textContent).toContain(
    'Unchanged files (2)',
  )
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

it('keeps changed files visible when unchanged files exceed the explorer limit', () => {
  const unchangedFiles = Array.from({ length: 100 }, (_, index) => ({
    path: `a-${String(index).padStart(3, '0')}.ts`,
    content: '',
  }))
  const crowdedAnalysis = analyzeArchitecture(
    {
      scope: '.',
      exclusions: [],
      files: [...unchangedFiles, { path: 'z-changed.ts', content: 'before' }],
    },
    {
      scope: '.',
      exclusions: [],
      files: [...unchangedFiles, { path: 'z-changed.ts', content: 'after' }],
    },
  )

  act(() =>
    root.render(
      <ArchitectureMap
        analysis={crowdedAnalysis}
        mode="overlay"
        onMode={() => undefined}
        onEvidence={() => undefined}
      />,
    ),
  )

  expect(
    container.querySelector('.architecture-file-group.changed .architecture-module')
      ?.textContent,
  ).toContain('z-changed.ts')
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
  const system = container.querySelector<HTMLElement>('[aria-label^="system (project)"]')!
  act(() => system.click())
  const subsystem = container.querySelector<HTMLElement>(
    '[aria-label^="subsystem data"]',
  )!
  act(() => subsystem.click())
  expect(container.querySelectorAll('.architecture-canvas-module')).toHaveLength(3)
  const reveal = container.querySelector<HTMLButtonElement>(
    '[aria-label="Show 1 unchanged module in data"]',
  )!
  expect(reveal.getAttribute('aria-expanded')).toBe('false')
  act(() => reveal.click())
  expect(reveal.getAttribute('aria-expanded')).toBe('true')
  expect(container.querySelectorAll('.architecture-canvas-module')).toHaveLength(4)
  act(() => subsystem.click())
  act(() => subsystem.click())
  expect(
    container
      .querySelector<HTMLButtonElement>('[aria-label="Show 1 unchanged module in data"]')
      ?.getAttribute('aria-expanded'),
  ).toBe('false')
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

it('gives module nodes a filename-first label with the full path on hover', () => {
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
  act(() =>
    container.querySelector<HTMLElement>('[aria-label^="system (project)"]')!.click(),
  )
  act(() =>
    container.querySelector<HTMLElement>('[aria-label^="subsystem data"]')!.click(),
  )
  const module = container.querySelector<HTMLElement>('[aria-label^="module data/a.ts"]')!
  expect(module.querySelector('strong')?.textContent).toBe('a.ts')
  expect(module.querySelector('.architecture-canvas-node-directory')?.textContent).toBe(
    'data',
  )
  expect(module.getAttribute('title')).toBe('data/a.ts')
})

it('lets the user choose layout orientation and spacing, and keeps the choice across Before/After/Overlay', () => {
  const render = (mode: 'before' | 'after' | 'overlay') =>
    act(() =>
      root.render(
        <ArchitectureMap
          analysis={analysis}
          mode={mode}
          onMode={() => undefined}
          onEvidence={() => undefined}
        />,
      ),
    )
  render('overlay')
  const orientationGroup = container.querySelector<HTMLElement>(
    '[aria-label="Layout orientation"]',
  )!
  const spacingGroup = container.querySelector<HTMLElement>(
    '[aria-label="Layout spacing"]',
  )!
  const vertical = Array.from(orientationGroup.querySelectorAll('button')).find(
    (button) => button.textContent === 'vertical',
  )!
  const compact = Array.from(spacingGroup.querySelectorAll('button')).find(
    (button) => button.textContent === 'compact',
  )!
  act(() => vertical.click())
  act(() => compact.click())
  expect(vertical.getAttribute('aria-pressed')).toBe('true')
  expect(compact.getAttribute('aria-pressed')).toBe('true')
  expect(vi.mocked(requestArchitectureLayout).mock.calls.at(-1)?.[1]).toEqual({
    orientation: 'vertical',
    spacing: 'compact',
  })

  render('before')
  render('after')
  expect(vertical.getAttribute('aria-pressed')).toBe('true')
  expect(compact.getAttribute('aria-pressed')).toBe('true')
})

it('reports the module cap explicitly and lets a search reach an omitted module', () => {
  const bigAnalysis = analyzeArchitecture(
    { scope: '.', exclusions: [], files: [] },
    {
      scope: '.',
      exclusions: [],
      files: Array.from({ length: ARCHITECTURE_MODULE_CAP + 5 }, (_, index) => ({
        path: `big/f${index}.ts`,
        content: `const x = ${index}`,
      })),
    },
  )
  act(() =>
    root.render(
      <ArchitectureMap
        analysis={bigAnalysis}
        mode="overlay"
        onMode={() => undefined}
        onEvidence={() => undefined}
      />,
    ),
  )
  act(() =>
    container.querySelector<HTMLElement>('[aria-label^="system (project)"]')!.click(),
  )
  act(() =>
    container.querySelector<HTMLElement>('[aria-label^="subsystem big"]')!.click(),
  )

  expect(container.querySelectorAll('.architecture-canvas-module')).toHaveLength(
    ARCHITECTURE_MODULE_CAP,
  )
  const capGroup = container.querySelector<HTMLElement>('[aria-label="Module cap"]')!
  expect(capGroup.querySelector('[role="status"]')?.textContent).toContain('5 modules')
  expect(container.querySelector('[aria-label^="module big/f99.ts"]')).toBeFalsy()

  const search = capGroup.querySelector<HTMLInputElement>('input')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      search,
      'f99',
    )
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.querySelector('[aria-label^="module big/f99.ts"]')).toBeTruthy()
})

it('focuses a subsystem without disturbing ownership expansion, and restores it on clear', () => {
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
  act(() =>
    container.querySelector<HTMLElement>('[aria-label^="system (project)"]')!.click(),
  )
  act(() =>
    container.querySelector<HTMLElement>('[aria-label^="subsystem data"]')!.click(),
  )
  expect(container.querySelectorAll('.architecture-canvas-module')).toHaveLength(3)

  const focusGroup = container.querySelector<HTMLElement>(
    '[aria-label="Focus subsystem"]',
  )!
  const select = focusGroup.querySelector('select')!
  act(() => {
    select.value = 'ui'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.querySelectorAll('.architecture-canvas-subsystem')).toHaveLength(2)
  expect(container.querySelectorAll('.architecture-canvas-module')).toHaveLength(0)

  const clear = Array.from(focusGroup.querySelectorAll('button')).find(
    (button) => button.textContent === 'Clear focus',
  )!
  act(() => clear.click())
  expect(container.querySelectorAll('.architecture-canvas-module')).toHaveLength(3)
})
