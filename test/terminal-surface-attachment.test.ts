// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'

import { TerminalSurfaceAttachment } from '../src/renderer/src/terminal/terminal-surface-attachment'
import type { TerminalPane } from '../src/renderer/src/terminal/terminal-pane'

describe('TerminalSurfaceAttachment', () => {
  it('grants one exact lease, hides before reparenting, and restores the current workspace container', () => {
    const surface = new TerminalSurfaceAttachment()
    const pane = fakePane()
    const workspace = document.createElement('div')
    const replacementWorkspace = document.createElement('div')
    const detail = document.createElement('div')
    const staleDetail = document.createElement('div')

    surface.attach(workspace, 'visible')
    surface.mountPane(pane.value, workspace)
    surface.synchronize('visible')
    const lease = surface.acquireLease()
    expect(lease).toBe(1)
    expect(surface.acquireLease()).toBeUndefined()
    expect(pane.presentation.mock.calls.map(([value]) => value)).toEqual([
      'hidden',
      'visible',
      'hidden',
    ])

    expect(surface.attachLease(lease!, detail, 'visible')).toBe(true)
    expect(pane.reparent).toHaveBeenCalledExactlyOnceWith(detail)
    expect(surface.currentContainer).toBe(detail)
    expect(surface.canFocus()).toBe(true)
    expect(surface.detachLease(lease! + 1, staleDetail)).toBe(false)
    expect(surface.releaseLease(lease! + 1)).toBe(false)
    expect(surface.currentContainer).toBe(detail)

    surface.attach(replacementWorkspace, 'hidden')
    surface.detach(workspace)
    expect(surface.currentContainer).toBe(detail)
    expect(surface.releaseLease(lease!)).toBe(true)
    expect(pane.reparent).toHaveBeenLastCalledWith(replacementWorkspace)
    expect(surface.currentContainer).toBe(replacementWorkspace)
    expect(surface.presentation).toBe('hidden')
    expect(surface.canFocus()).toBe(false)
  })

  it('returns a detached lease surface hidden without allowing late cleanup to move a successor', () => {
    const surface = new TerminalSurfaceAttachment()
    const pane = fakePane()
    const workspace = document.createElement('div')
    const first = document.createElement('div')
    const second = document.createElement('div')
    surface.attach(workspace, 'hidden')
    surface.mountPane(pane.value, workspace)

    const firstLease = surface.acquireLease()!
    surface.attachLease(firstLease, first, 'visible')
    expect(surface.detachLease(firstLease, first)).toBe(true)
    expect(surface.currentContainer).toBe(workspace)
    expect(surface.presentation).toBe('hidden')
    surface.releaseLease(firstLease)

    const secondLease = surface.acquireLease()!
    surface.attachLease(secondLease, second, 'visible')
    expect(surface.releaseLease(firstLease)).toBe(false)
    expect(surface.currentContainer).toBe(second)
    expect(surface.isCurrentLease(secondLease, second)).toBe(true)
  })

  it('hands a held size to the pane and withdraws geometry ownership until it is released', () => {
    const surface = new TerminalSurfaceAttachment()
    const pane = fakePane()
    const workspace = document.createElement('div')
    surface.attach(workspace, 'visible')
    surface.mountPane(pane.value, workspace)
    surface.synchronize('visible')
    expect(surface.ownsGeometry()).toBe(true)

    surface.holdGeometry({ cols: 61, rows: 23 })

    expect(pane.heldGeometry).toHaveBeenCalledExactlyOnceWith({ cols: 61, rows: 23 })
    expect(surface.ownsGeometry()).toBe(false)
    expect(surface.canFocus()).toBe(true)

    // Hidden still wins: the pane is told to hide, and reveal does not re-send the hold.
    surface.synchronize('hidden')
    surface.synchronize('visible')
    expect(pane.presentation.mock.calls.map(([value]) => value)).toEqual([
      'hidden',
      'visible',
      'hidden',
      'visible',
    ])
    expect(pane.heldGeometry).toHaveBeenCalledOnce()
    expect(surface.ownsGeometry()).toBe(false)

    surface.holdGeometry(undefined)
    expect(pane.heldGeometry).toHaveBeenLastCalledWith(undefined)
    expect(surface.ownsGeometry()).toBe(true)

    surface.holdGeometry({ cols: 61, rows: 23 })
    surface.releaseResources()
    expect(surface.ownsGeometry()).toBe(false)
    surface.mountPane(pane.value, workspace)
    surface.synchronize('visible')
    expect(surface.ownsGeometry()).toBe(true)
  })
})

function fakePane() {
  const mount = vi.fn()
  const reparent = vi.fn()
  const presentation = vi.fn<TerminalPane['setPresentation']>()
  const heldGeometry = vi.fn<TerminalPane['setHeldGeometry']>()
  return {
    mount,
    reparent,
    presentation,
    heldGeometry,
    value: {
      mount,
      reparent,
      setPresentation: presentation,
      setHeldGeometry: heldGeometry,
    } as unknown as TerminalPane,
  }
}
