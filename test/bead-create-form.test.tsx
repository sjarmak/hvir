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
type OnCreate = (title: string) => Promise<boolean>

function Owner({
  onCreate,
  disabledHint,
}: {
  readonly onCreate: OnCreate
  readonly disabledHint?: string
}): ReactElement {
  const [value, setValue] = useState('')
  return createElement(BeadCreateForm, {
    value,
    onChange: setValue,
    onCreate,
    ...(disabledHint === undefined ? {} : { disabledHint }),
  })
}

function render(onCreate: OnCreate, disabledHint?: string): void {
  act(() => {
    root.render(
      createElement(Owner, {
        onCreate,
        ...(disabledHint === undefined ? {} : { disabledHint }),
      }),
    )
  })
}

const accept: OnCreate = () => Promise.resolve(true)
const reject: OnCreate = () => Promise.resolve(false)

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
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

async function submit(): Promise<void> {
  await act(async () => {
    const form = host.querySelector('form')
    if (!form) throw new Error('form not rendered')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

describe('BeadCreateForm', () => {
  it('disables the submit button while the title is empty or whitespace', () => {
    render(accept)
    expect(button().disabled).toBe(true)
    type('   ')
    expect(button().disabled).toBe(true)
    type('x')
    expect(button().disabled).toBe(false)
  })

  it('submits the normalized title once and clears the field when accepted', async () => {
    const onCreate = vi.fn(accept)
    render(onCreate)
    type('  Ship  it ')
    await submit()
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith('Ship it')
    await settle()
    expect(input().value).toBe('')
  })

  it('keeps the typed title when the request was not accepted', async () => {
    const onCreate = vi.fn(reject)
    render(onCreate)
    type('Ship it')
    await submit()
    expect(onCreate).toHaveBeenCalledTimes(1)
    await settle()
    expect(input().value).toBe('Ship it')
  })

  it('disables submit with the hint while no terminal can launch, keeping the title', async () => {
    const onCreate = vi.fn(accept)
    render(onCreate, 'No terminal can launch here')
    type('Ship it')
    expect(button().disabled).toBe(true)
    expect(button().title).toBe('No terminal can launch here')
    await submit()
    expect(onCreate).not.toHaveBeenCalled()
    expect(input().value).toBe('Ship it')
  })

  it('handles the form submit event (Enter) without navigating', async () => {
    const onCreate = vi.fn(accept)
    render(onCreate)
    type('Enter title')
    const form = host.querySelector('form')
    if (!form) throw new Error('form not rendered')
    const event = new Event('submit', { bubbles: true, cancelable: true })
    await act(async () => {
      form.dispatchEvent(event)
      await Promise.resolve()
    })
    expect(event.defaultPrevented).toBe(true)
    expect(onCreate).toHaveBeenCalledWith('Enter title')
  })

  it('collapses pasted whitespace runs to a space before submitting', async () => {
    // A text input strips newlines itself (browser semantics, mirrored by
    // happy-dom); tabs and repeated spaces from a paste still reach the value.
    const onCreate = vi.fn(accept)
    render(onCreate)
    type('two\t  lines')
    await submit()
    expect(onCreate).toHaveBeenCalledWith('two lines')
  })

  it('ignores a submit while the title is blank', async () => {
    const onCreate = vi.fn(accept)
    render(onCreate)
    await submit()
    expect(onCreate).not.toHaveBeenCalled()
  })
})
