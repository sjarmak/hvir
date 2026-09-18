// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CompanionApp } from '../src/renderer/companion/src/App'
import {
  COMPANION_TOKEN_STORAGE_KEY,
  browserTokenStore,
  createCompanionClient,
} from '../src/renderer/companion/src/companion-client'
import { FakeCompanionServer, row, snapshot, transcript } from './companion-page-fixture'

let host: HTMLDivElement
let root: Root
let server: FakeCompanionServer

beforeEach(() => {
  ;(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  server = new FakeCompanionServer()
  // The page must never reach for the desktop bridge (ADR-049 module boundary).
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    get: () => {
      throw new Error('window.hvir was read by the Companion page')
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { hvir?: unknown }).hvir
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function render(): Promise<void> {
  const client = createCompanionClient({
    fetch: server.fetch,
    tokens: browserTokenStore(() => localStorage),
  })
  await act(async () => {
    root.render(createElement(CompanionApp, { client }))
    await Promise.resolve()
  })
  await settle()
}

async function renderPaired(): Promise<void> {
  localStorage.setItem(COMPANION_TOKEN_STORAGE_KEY, server.token)
  await render()
}

async function emit(event: string, data: unknown): Promise<void> {
  act(() => {
    server.emit(event, data)
  })
  await settle()
}

function button(label: string): HTMLButtonElement {
  const element = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (element === undefined) throw new Error(`missing button ${label}`)
  return element
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
  await settle()
}

async function type(selector: string, value: string): Promise<void> {
  await act(async () => {
    const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
    if (element === null) throw new Error(`missing ${selector}`)
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

function rowHandles(): string[] {
  return [...host.querySelectorAll<HTMLElement>('.companion-row')].map(
    (element) => element.dataset['handle'] ?? '',
  )
}

const READY_ROW = row({
  handle: 'ready-1',
  title: 'Fix the build',
  attention: { status: 'available', value: 'ready', observedAt: 5 },
})
const STALE_ROW = row({
  handle: 'stale-1',
  title: 'Waiting on review',
  attention: { status: 'stale', value: 'ready', observedAt: 5, reason: 'source-stale' },
  freshness: 'stale',
  reason: 'closed',
})
const QUIET_ROW = row({
  handle: 'quiet-1',
  title: 'Quiet terminal',
  origin: { kind: 'hvir-terminal' },
  canAnswer: false,
})

describe('Companion page', () => {
  it('shows the pairing screen without a token and pairs with the code typed', async () => {
    await render()
    expect(host.querySelector('#companion-pair-code')).not.toBeNull()
    expect(server.calls).toHaveLength(0)

    await type('#companion-pair-code', ' ABCD-EFGH ')
    await click(button('Pair'))

    expect(server.calls[0]).toMatchObject({
      url: '/pair',
      method: 'POST',
      body: { code: 'ABCD-EFGH' },
    })
    expect(localStorage.getItem(COMPANION_TOKEN_STORAGE_KEY)).toBe('tok-1')
    expect(server.calls[1]).toMatchObject({
      url: '/api/events',
      authorization: 'Bearer tok-1',
    })
    await emit('snapshot', snapshot(1, [READY_ROW]))
    expect(rowHandles()).toEqual(['ready-1'])
  })

  it('says why a pairing code was refused and stays on the pairing screen', async () => {
    server.pairStatus = 401
    await render()
    await type('#companion-pair-code', 'WRONG')
    await click(button('Pair'))
    expect(host.querySelector('.companion-error')?.textContent).toContain(
      'Pairing code rejected',
    )
    expect(host.querySelector('#companion-pair-code')).not.toBeNull()
    expect(localStorage.getItem(COMPANION_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('renders rows in snapshot order with attention, unconfirmed reason, or nothing', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW, STALE_ROW, QUIET_ROW]))

    expect(rowHandles()).toEqual(['ready-1', 'stale-1', 'quiet-1'])
    const [ready, stale, quiet] = [...host.querySelectorAll('.companion-row')]
    expect(ready?.querySelector('.companion-badge-attention')?.textContent).toBe('ready')
    expect(ready?.querySelector('.companion-badge-stale')).toBeNull()
    expect(stale?.querySelector('.companion-badge-stale')?.textContent).toBe(
      'unconfirmed (closed)',
    )
    expect(quiet?.querySelectorAll('.companion-badge')).toHaveLength(0)
    expect(quiet?.textContent).toContain('Quiet terminal')
    expect(ready?.textContent).toContain('hvir / main')
  })

  it('ignores a snapshot revision older than the one it shows', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(2, [READY_ROW]))
    await emit('snapshot', snapshot(1, [QUIET_ROW]))
    expect(rowHandles()).toEqual(['ready-1'])

    await emit('snapshot', snapshot(3, [QUIET_ROW]))
    expect(rowHandles()).toEqual(['quiet-1'])
  })

  it('selects a row, answers its pending interaction and sends a trimmed message', async () => {
    server.transcriptReply = transcript({
      handle: 'ready-1',
      turns: [
        { ordinal: 1, role: 'user', kind: 'text', text: 'please fix the build' },
        { ordinal: 2, role: 'assistant', kind: 'text', text: 'Which branch?' },
      ],
      pending: {
        revision: 7,
        prompt: 'Which branch?',
        options: [
          { ordinal: 1, label: 'main' },
          { ordinal: 2, label: 'release' },
        ],
      },
    })
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))

    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/sessions/ready-1/select',
      body: { page: 'page-1' },
    })
    expect(host.querySelector('.companion-transcript')).not.toBeNull()
    expect(
      [...host.querySelectorAll('.companion-turn')].map((turn) => turn.textContent),
    ).toEqual(['userplease fix the build', 'assistantWhich branch?'])
    expect(host.querySelector('.companion-pending-prompt')?.textContent).toBe(
      'Which branch?',
    )

    await click(button('release'))
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/sessions/ready-1/respond',
      body: { page: 'page-1', handle: 'ready-1', pendingRevision: 7, optionOrdinal: 2 },
    })

    const before = server.calls.length
    await type('#companion-message', '   ')
    await click(button('Send'))
    expect(server.calls).toHaveLength(before)

    await type('#companion-message', '  ship it  ')
    await click(button('Send'))
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/sessions/ready-1/message',
      body: { page: 'page-1', handle: 'ready-1', message: 'ship it' },
    })
    expect(host.querySelector<HTMLTextAreaElement>('#companion-message')?.value).toBe('')
  })

  it('follows transcript events for the selected row and offers resume when lost', async () => {
    server.transcriptReply = transcript({ handle: 'ready-1', revision: 1 })
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)

    await emit('transcript', transcript({ handle: 'other', revision: 5, stream: 'lost' }))
    expect(host.querySelector('.companion-stream')).toBeNull()

    await emit(
      'transcript',
      transcript({
        handle: 'ready-1',
        revision: 2,
        stream: 'lost',
        streamReason: 'timeout',
      }),
    )
    expect(host.querySelector('.companion-stream')?.textContent).toContain('timeout')
    await click(button('Resume'))
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/sessions/ready-1/resume',
      body: { page: 'page-1' },
    })

    await click(button('Sessions'))
    expect(host.querySelector('.companion-transcript')).toBeNull()
    expect(rowHandles()).toEqual(['ready-1'])
  })

  it('shows a refused answer with its reason instead of retrying', async () => {
    server.transcriptReply = transcript({
      handle: 'ready-1',
      pending: { revision: 1, options: [{ ordinal: 1, label: 'yes' }] },
    })
    server.mutationReply = { outcome: 'unavailable', reason: 'stale-interaction' }
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)

    const before = server.calls.length
    await click(button('yes'))
    expect(server.calls).toHaveLength(before + 1)
    expect(host.querySelector('.companion-error')?.textContent).toContain(
      'stale-interaction',
    )
  })

  it('shows disconnected with a manual reconnect and never retries on its own', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))

    act(() => {
      server.drop()
    })
    await settle()
    await settle()

    expect(host.querySelector('.companion-connection')?.textContent).toContain(
      'Disconnected',
    )
    expect(server.streams()).toBe(1)

    await click(button('Reconnect'))
    expect(server.streams()).toBe(2)
    await emit('snapshot', snapshot(1, [QUIET_ROW]))
    expect(rowHandles()).toEqual(['quiet-1'])
    expect(host.querySelector('.companion-connection')).toBeNull()
  })

  it('returns to the pairing screen when the server revokes the pairing', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))

    await emit('closed', { reason: 'revoked' })

    expect(host.querySelector('#companion-pair-code')).not.toBeNull()
    expect(localStorage.getItem(COMPANION_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('forgets a token the server no longer accepts and asks to pair again', async () => {
    localStorage.setItem(COMPANION_TOKEN_STORAGE_KEY, 'stale-token')
    await render()

    expect(server.calls[0]).toMatchObject({
      url: '/api/events',
      authorization: 'Bearer stale-token',
    })
    expect(host.querySelector('#companion-pair-code')).not.toBeNull()
    expect(localStorage.getItem(COMPANION_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('closes the stream when the page unmounts', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))
    act(() => root.unmount())
    root = createRoot(host)
    expect(() => server.emit('snapshot', snapshot(2, []))).toThrow('no open event stream')
  })
})
