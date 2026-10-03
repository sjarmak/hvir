// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InstanceSwitcher } from '../src/renderer/companion/src/instance-switcher'
import { companionInstanceStorage } from '../src/renderer/companion/src/companion-instance-links'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(onLeave = vi.fn()): ReturnType<typeof vi.fn> {
  act(() => {
    root.render(<InstanceSwitcher currentUrl="https://desk.example/" onLeave={onLeave} />)
  })
  return onLeave
}

describe('Companion instance switcher', () => {
  it('shows the current endpoint and saves an endpoint entered in the catalog', () => {
    render()
    expect(container.textContent).toContain('https://desk.example/')
    expect(container.querySelector('button[type="submit"]')?.textContent).toBe('Save')
    const name = container.querySelector('#companion-instance-name') as HTMLInputElement
    const url = container.querySelector(
      '[aria-label="Companion endpoint URL"]',
    ) as HTMLInputElement
    act(() => {
      setInput(name, 'Office')
      setInput(url, 'https://office.example/path')
      ;(container.querySelector('button[type="submit"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('root')
    act(() => {
      setInput(url, 'https://office.example/')
      ;(container.querySelector('button[type="submit"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(localStorage.getItem('hvir.companion.instance-links.v1')).toContain(
      'office.example',
    )
  })

  it('opens a saved link with no referrer and calls leave synchronously', () => {
    localStorage.setItem(
      'hvir.companion.instance-links.v1',
      JSON.stringify([{ id: 'one', name: 'Lab', url: 'https://lab.example/' }]),
    )
    const onLeave = render()
    const anchor = container.querySelector(
      'a[href="https://lab.example/"]',
    ) as HTMLAnchorElement
    expect(anchor.referrerPolicy).toBe('no-referrer')
    anchor.click()
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('does not suspend for modified or non-primary link activation', () => {
    localStorage.setItem(
      'hvir.companion.instance-links.v1',
      JSON.stringify([{ id: 'one', name: 'Lab', url: 'https://lab.example/' }]),
    )
    const onLeave = render()
    const anchor = container.querySelector(
      'a[href="https://lab.example/"]',
    ) as HTMLAnchorElement
    for (const init of [
      { button: 1 },
      { button: 0, ctrlKey: true },
      { button: 0, metaKey: true },
      { button: 0, shiftKey: true },
      { button: 0, altKey: true },
    ]) {
      anchor.dispatchEvent(
        Object.assign(new MouseEvent('click', { bubbles: true, cancelable: true }), init),
      )
    }
    expect(onLeave).not.toHaveBeenCalled()
  })

  it('shows a truthful corruption error without replacing the saved bytes', () => {
    localStorage.setItem('hvir.companion.instance-links.v1', '{')
    render()
    expect(container.textContent).toContain('Saved Companion links are unreadable')
    expect(localStorage.getItem('hvir.companion.instance-links.v1')).toBe('{')
  })

  it('guards storage acquisition when the browser denies local storage', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied')
      },
    })
    expect(companionInstanceStorage()).toBeUndefined()
    if (original) Object.defineProperty(window, 'localStorage', original)
  })

  it('renames, removes, and recovers saved links through visible controls', () => {
    localStorage.setItem(
      'hvir.companion.instance-links.v1',
      JSON.stringify([{ id: 'one', name: 'Lab', url: 'https://lab.example/' }]),
    )
    render()
    act(() => {
      ;[...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Rename')!
        .click()
    })
    const renameInput = container.querySelector(
      '[aria-label="Rename Lab"]',
    ) as HTMLInputElement
    act(() => {
      setInput(renameInput, 'Research')
      ;(
        renameInput.form!.querySelector('button[type="submit"]') as HTMLButtonElement
      ).click()
    })
    expect(container.textContent).toContain('Research')
    act(() => {
      ;[...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Remove')!
        .click()
    })
    expect(container.textContent).toContain('No saved hvir instances.')
    localStorage.setItem('hvir.companion.instance-links.v1', '{')
    act(() => root.unmount())
    root = createRoot(container)
    render()
    act(() => {
      ;[...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Remove saved links')!
        .click()
    })
    expect(localStorage.getItem('hvir.companion.instance-links.v1')).toBeNull()
  })
})

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.bind(input)
  setter?.(value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
