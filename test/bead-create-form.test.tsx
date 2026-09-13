// @vitest-environment happy-dom

import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BeadCreateForm } from '../src/renderer/src/beads/bead-create-form'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** The panel owns the field value; this stands in for it. */
function Owner({ onCreate }: { readonly onCreate: (title: string) => void }): ReactElement {
  const [value, setValue] = useState('')
  return createElement(BeadCreateForm, { value, onChange: setValue, onCreate })
}

function render(onCreate: (title: string) => void): void {
  act(() => {
    root.render(createElement(Owner, { onCreate }))
  })
}

function input(): HTMLInputElement {
  const element = host.querySelector('input')
  if (!element) throw new Error('input not rendered')
  return element
}

function button(): HTMLButtonElement {
  const element = host.querySelector('button')
  if (!element) throw new Error('button not rendered')
  return element
}

function type(value: string): void {
  act(() => {
    const element = input()
    // Bypass React's value tracker so the change registers as user input.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      element,
      value,
    )
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submit(): void {
  act(() => {
    const form = host.querySelector('form')
    if (!form) throw new Error('form not rendered')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('BeadCreateForm', () => {
  it('disables the submit button while the title is empty or whitespace', () => {
    render(vi.fn())
    expect(button().disabled).toBe(true)
    type('   ')
    expect(button().disabled).toBe(true)
    type('x')
    expect(button().disabled).toBe(false)
  })

  it('submits the normalized title once and clears the field', () => {
    const onCreate = vi.fn()
    render(onCreate)
    type('  Ship  it ')
    submit()
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith('Ship it')
    expect(input().value).toBe('')
  })

  it('handles the form submit event (Enter) without navigating', () => {
    const onCreate = vi.fn()
    render(onCreate)
    type('Enter title')
    const form = host.querySelector('form')
    if (!form) throw new Error('form not rendered')
    const event = new Event('submit', { bubbles: true, cancelable: true })
    act(() => {
      form.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(onCreate).toHaveBeenCalledWith('Enter title')
  })

  it('collapses pasted whitespace runs to a space before submitting', () => {
    // A text input strips newlines itself (browser semantics, mirrored by
    // happy-dom); tabs and repeated spaces from a paste still reach the value.
    const onCreate = vi.fn()
    render(onCreate)
    type('two\t  lines')
    submit()
    expect(onCreate).toHaveBeenCalledWith('two lines')
  })

  it('ignores a submit while the title is blank', () => {
    const onCreate = vi.fn()
    render(onCreate)
    submit()
    expect(onCreate).not.toHaveBeenCalled()
  })
})
