// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArchitectureMap } from '../src/renderer/src/architecture-review/ArchitectureMap'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'

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
    container.querySelectorAll<HTMLElement>('.architecture-subsystem'),
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
    Array.from(container.querySelectorAll<HTMLElement>('.architecture-subsystem')).map(
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
