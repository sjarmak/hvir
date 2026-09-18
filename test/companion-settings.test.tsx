// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { CompanionSettings } from '../src/renderer/src/settings/sections/CompanionSettings'
import type { CompanionConfigView } from '../src/shared'

const BASE: CompanionConfigView = {
  enabled: false,
  port: 47811,
  paired: false,
  push: undefined,
  status: { listening: false },
}

let host: HTMLDivElement
let root: Root
let invoke: Mock<(channel: string, payload?: unknown) => Promise<unknown>>
let listeners: Map<string, (payload: unknown) => void>
let views: Record<string, CompanionConfigView>

beforeEach(() => {
  ;(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  listeners = new Map()
  views = { 'companion:config': BASE }
  invoke = vi.fn((channel: string) => {
    const view = views[channel]
    return view === undefined
      ? Promise.reject(new Error(`no answer for ${channel}`))
      : Promise.resolve(view)
  })
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.hvir = {
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(CompanionSettings))
    await Promise.resolve()
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function input(id: string): HTMLInputElement {
  const element = host.querySelector<HTMLInputElement>(`#${id}`)
  if (element === null) throw new Error(`missing #${id}`)
  return element
}

function button(label: string): HTMLButtonElement {
  const element = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (element === undefined) throw new Error(`missing button ${label}`)
  return element
}

async function type(id: string, value: string): Promise<void> {
  await act(async () => {
    const element = input(id)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      element,
      value,
    )
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
  })
  await settle()
}

describe('CompanionSettings section', () => {
  it('reads the config once, subscribes to status changes, and shows no token', async () => {
    views['companion:config'] = {
      ...BASE,
      enabled: true,
      port: 50_000,
      push: { url: 'https://ntfy.example/hvir', tokenConfigured: true },
    }
    await render()
    await settle()

    expect(invoke.mock.calls.map((call) => call[0])).toEqual(['companion:config'])
    expect(listeners.has('companion:status-changed')).toBe(true)
    expect(host.querySelector('#settings-companion-title')?.textContent).toBe('Companion')
    expect(input('settings-companion-enabled').checked).toBe(true)
    expect(input('settings-companion-port').value).toBe('50000')
    expect(input('settings-companion-push-url').value).toBe('https://ntfy.example/hvir')
    expect(input('settings-companion-push-token').type).toBe('password')
    expect(input('settings-companion-push-token').value).toBe('')
    expect(host.textContent).toContain('token set')
    expect(host.querySelector('.settings-companion-status')?.textContent).toBe(
      'Not listening',
    )
  })

  it('follows the listener status the main process publishes', async () => {
    await render()
    await settle()
    await act(async () => {
      listeners.get('companion:status-changed')?.({
        ...BASE,
        status: { listening: true, port: 47811 },
      })
      await Promise.resolve()
    })
    expect(host.querySelector('.settings-companion-status')?.textContent).toBe(
      'Listening on 127.0.0.1:47811',
    )
    await act(async () => {
      listeners.get('companion:status-changed')?.({
        ...BASE,
        status: { listening: false, error: 'port 47811 is in use' },
      })
      await Promise.resolve()
    })
    expect(host.querySelector('.settings-companion-status')?.textContent).toBe(
      'Not listening: port 47811 is in use',
    )
  })

  it('issues a pairing code and revokes the pairing through the main process', async () => {
    views['companion:pairing-issue'] = {
      ...BASE,
      pairing: { code: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX', expiresAt: Date.now() + 600_000 },
    }
    views['companion:pairing-revoke'] = BASE
    await render()
    await settle()
    expect(host.textContent).toContain('Not paired')

    await click('Issue pairing code')
    expect(invoke).toHaveBeenLastCalledWith('companion:pairing-issue', undefined)
    expect(host.querySelector('.settings-companion-code')?.textContent).toBe(
      'ABCD-EFGH-IJKL-MNOP-QRST-UVWX',
    )

    await act(async () => {
      listeners.get('companion:status-changed')?.({ ...BASE, paired: true })
      await Promise.resolve()
    })
    expect(host.textContent).toContain('Paired')
    await click('Revoke pairing')
    expect(invoke).toHaveBeenLastCalledWith('companion:pairing-revoke', undefined)
    expect(host.textContent).toContain('Not paired')
  })

  it('saves the draft with the token only when one was typed', async () => {
    views['companion:config'] = {
      ...BASE,
      push: { url: 'https://ntfy.example/hvir', tokenConfigured: true },
    }
    views['companion:config-save'] = {
      ...BASE,
      enabled: true,
      port: 50_000,
      push: { url: 'https://ntfy.example/hvir', tokenConfigured: true },
    }
    await render()
    await settle()

    await act(async () => {
      input('settings-companion-enabled').click()
      await Promise.resolve()
    })
    await type('settings-companion-port', '50000')
    await click('Apply')
    expect(invoke).toHaveBeenLastCalledWith('companion:config-save', {
      enabled: true,
      port: 50_000,
      push: { url: 'https://ntfy.example/hvir' },
    })

    await type('settings-companion-push-token', 'fresh-token')
    await click('Apply')
    expect(invoke).toHaveBeenLastCalledWith('companion:config-save', {
      enabled: true,
      port: 50_000,
      push: { url: 'https://ntfy.example/hvir', token: 'fresh-token' },
    })
    expect(input('settings-companion-push-token').value).toBe('')
  })

  it('removes the stored token explicitly and shows a failed save', async () => {
    views['companion:config'] = {
      ...BASE,
      push: { url: 'https://ntfy.example/hvir', tokenConfigured: true },
    }
    views['companion:config-save'] = {
      ...BASE,
      push: { url: 'https://ntfy.example/hvir', tokenConfigured: false },
    }
    await render()
    await settle()

    await click('Remove token')
    expect(invoke).toHaveBeenLastCalledWith('companion:config-save', {
      enabled: false,
      port: 47811,
      push: { url: 'https://ntfy.example/hvir', token: '' },
    })
    expect(host.textContent).not.toContain('token set')

    delete views['companion:config-save']
    await type('settings-companion-push-url', '')
    await click('Apply')
    expect(host.querySelector('.dialog-error')?.textContent).toContain(
      'no answer for companion:config-save',
    )
  })
})
