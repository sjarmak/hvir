// @vitest-environment happy-dom

import { act } from 'react'
import { describe, expect, it } from 'vitest'

import { row, snapshot, transcript } from './companion-page-fixture'
import {
  armButton,
  button,
  click,
  emit,
  hide,
  host,
  openMirror,
  panes,
  renderPaired,
  rowHandles,
  server,
  settle,
  show,
  useCompanionPage,
} from './companion-page-harness'

useCompanionPage()

const READY_ROW = row({ handle: 'ready-1', title: 'ready session' })

async function drop(): Promise<void> {
  act(() => {
    server.drop()
  })
  await settle()
  await settle()
}

function banner(): string | undefined {
  return host.querySelector('.companion-connection')?.textContent ?? undefined
}

function selects(): unknown[] {
  return server.calls
    .filter((call) => call.url.endsWith('/select'))
    .map((call) => call.url)
}

async function openTranscript(): Promise<void> {
  server.transcriptReply = transcript({ handle: 'ready-1' })
  await renderPaired()
  await emit('snapshot', snapshot(1, [READY_ROW]))
  await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
}

describe('Companion page reopening after the phone looks away', () => {
  it('reopens a stream lost while hidden when the page is shown again', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))
    await hide()
    await drop()
    expect(banner()).toContain('Disconnected')
    expect(server.streams()).toBe(1)

    await show()
    expect(server.streams()).toBe(2)
    await emit('snapshot', snapshot(2, [READY_ROW]))
    expect(banner()).toBeUndefined()
    expect(rowHandles()).toEqual(['ready-1'])
  })

  it('reopens once for a stream lost after the page returns, then waits for a person', async () => {
    await renderPaired()
    await hide()
    await show()
    expect(server.streams()).toBe(1)

    await drop()
    expect(server.streams()).toBe(2)
    await drop()
    expect(server.streams()).toBe(2)
    expect(banner()).toContain('Disconnected')
  })

  it('leaves a page restored from history disconnected when it is shown (ADR-972)', async () => {
    await renderPaired()
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })
    await settle()
    await show()

    expect(server.streams()).toBe(1)
    expect(host.textContent).toContain('This page is suspended')
  })
})

describe('Companion page reconnect keeps the open session', () => {
  it('stays in the session while reconnecting and selects it again on the new stream', async () => {
    await openTranscript()
    expect(selects()).toEqual(['/api/sessions/ready-1/select'])
    await drop()

    server.holdEvents = true
    await click(button('Reconnect'))
    expect(host.querySelector('.companion-transcript')).not.toBeNull()
    expect(banner()).toContain('Connecting')
    expect(selects()).toHaveLength(1)

    server.holdEvents = false
    await act(async () => {
      server.releaseEvents()
      await Promise.resolve()
    })
    await settle()
    expect(selects()).toEqual([
      '/api/sessions/ready-1/select',
      '/api/sessions/ready-1/select',
    ])
    expect(host.querySelector('.companion-transcript')).not.toBeNull()
    expect(banner()).toBeUndefined()
  })

  it('does not select a session again once the person left it while reconnecting', async () => {
    await openTranscript()
    await drop()

    server.holdEvents = true
    await click(button('Reconnect'))
    await click(button('Sessions'))
    expect(host.querySelector('.companion-transcript')).toBeNull()

    server.holdEvents = false
    await act(async () => {
      server.releaseEvents()
      await Promise.resolve()
    })
    await settle()
    expect(selects()).toHaveLength(1)
    expect(banner()).toBeUndefined()
  })

  it('returns to the list with the reason when the session cannot be selected again', async () => {
    await openTranscript()
    await drop()
    server.verbStatus = 409

    await click(button('Reconnect'))
    await emit('snapshot', snapshot(2, [READY_ROW]))

    expect(host.querySelector('.companion-transcript')).toBeNull()
    expect(rowHandles()).toEqual(['ready-1'])
    expect(host.querySelector('.companion-error')?.textContent).toBe('Refused')
  })

  it('reopens a mirror row as a fresh, disarmed mirror', async () => {
    await openMirror()
    await click(armButton())
    expect(armButton().dataset['armed']).toBe('true')
    await drop()

    await click(button('Reconnect'))
    expect(selects()).toHaveLength(2)
    expect(armButton().dataset['armed']).toBe('false')
    await emit('terminal', { type: 'opened', handle: 'term-1', cols: 80, rows: 24, tail: '' })

    expect(host.querySelector('.companion-terminal')).not.toBeNull()
    expect(armButton().dataset['armed']).toBe('false')
    expect(panes.panes.at(-1)?.inputEnabled).toEqual([false])
  })
})
