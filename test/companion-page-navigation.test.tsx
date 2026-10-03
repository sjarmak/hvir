// @vitest-environment happy-dom

import { act } from 'react'
import { describe, expect, it } from 'vitest'

import {
  MIRROR_ROW,
  NOT_PROJECTED,
  armButton,
  button,
  click,
  emit,
  host,
  openMirror,
  panes,
  renderPaired,
  render,
  renderSessionProbe,
  server,
  settle,
  sessionProbe,
  type,
  useCompanionPage,
} from './companion-page-harness'
import { snapshot, transcript } from './companion-page-fixture'

useCompanionPage()

describe('Companion page navigation lifecycle', () => {
  it('ignores a pairing completion after pagehide', async () => {
    server.holdPair = true
    await render()
    await type('#companion-pair-code', 'ABCD-EFGH')
    await click(button('Pair'))

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })
    server.releasePair()
    await settle()

    expect(host.querySelector('#companion-pair-code')).not.toBeNull()
    expect(server.streams()).toBe(0)
  })

  it('pagehide closes and clears the mirror, feed, and input arming', async () => {
    await openMirror('tail')
    await click(armButton())
    expect(panes.panes[0]?.writes).toEqual(['tail'])

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })
    await settle()

    expect(host.querySelector('.companion-terminal')).toBeNull()
    expect(host.querySelector('.companion-arm')).toBeNull()
    expect(host.textContent).toContain('This page is suspended')
    expect(server.streams()).toBe(1)
    expect(() => server.emit('snapshot', snapshot(2, [MIRROR_ROW]))).toThrow(
      'no open event stream',
    )
  })

  it('aborts an event opening immediately on pagehide', async () => {
    server.holdEvents = true
    await renderPaired()
    const eventCall = server.calls.find((call) => call.url === '/api/events')
    expect(eventCall).toBeDefined()
    expect(eventCall?.signal?.aborted).toBe(false)

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })

    expect(eventCall?.signal?.aborted).toBe(true)
    server.releaseEvents()
    await settle()
    expect(host.textContent).toContain('This page is suspended')
  })

  it('ignores a select that resolves after pagehide', async () => {
    server.transcriptReply = transcript({ handle: 'term-1' })
    server.holdSelect = true
    await renderPaired()
    await emit('snapshot', snapshot(1, [MIRROR_ROW]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })
    server.releaseSelect()
    await settle()

    expect(host.querySelector('.companion-transcript')).toBeNull()
    expect(host.querySelector('.companion-terminal')).toBeNull()
    expect(host.textContent).toContain('This page is suspended')
  })

  it('keeps a BFCache restore disconnected until explicit reconnect', async () => {
    server.transcriptReply = NOT_PROJECTED
    await renderPaired()
    const streams = server.streams()

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      window.dispatchEvent(new Event('pageshow'))
      await Promise.resolve()
    })
    await settle()

    expect(server.streams()).toBe(streams)
    expect(host.textContent).toContain('This page is suspended')

    await click(button('Reconnect'))
    expect(server.streams()).toBe(streams + 1)
  })

  it('does not send a viewport or queued input after pagehide', async () => {
    server.transcriptReply = NOT_PROJECTED
    await openMirror()
    server.holdViewport = true
    await act(async () => {
      panes.panes[0]?.emitData('stale')
      await Promise.resolve()
    })
    await settle()
    const beforeLeave = server.calls.length

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })
    server.releaseViewports()
    await settle()

    expect(server.calls.slice(beforeLeave).some((call) => call.url.endsWith('/input'))).toBe(
      false,
    )
    expect(server.viewports()).toHaveLength(0)
  })

  it('rejects captured input and viewport callbacks after pagehide', async () => {
    server.transcriptReply = NOT_PROJECTED
    localStorage.setItem('hvir-companion:token:v1', server.token)
    await renderSessionProbe()
    await emit('snapshot', snapshot(1, [MIRROR_ROW]))
    await act(async () => {
      await sessionProbe?.select(MIRROR_ROW.handle)
    })
    await emit('terminal', { type: 'opened', handle: 'term-1', cols: 80, rows: 24 })
    const input = sessionProbe?.input
    const viewport = sessionProbe?.viewport
    const beforeLeave = server.calls.length
    expect(input).toBeDefined()
    expect(viewport).toBeDefined()

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })

    await input!('stale', 'navigation')
    await expect(viewport!(80, 24)).rejects.toThrow('No mirror is live')
    await settle()
    expect(server.calls).toHaveLength(beforeLeave)
  })
})
