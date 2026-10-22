import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { AttentionBadge } from '../src/main/attention-badge'
import type { RendererOwner } from '../src/main/renderer-resource-scopes'
import { bindRendererFocus } from '../src/main/window/window-focus-binding'

function attention() {
  const badge = new AttentionBadge(() => true)
  return {
    windowFocus: badge.windowFocus,
    setOwnerFocused: (owner: RendererOwner, focused: boolean) =>
      badge.setFocused(owner.id, focused, owner.generation),
    removeOwner: (owner: RendererOwner) => badge.remove(owner.id, owner.generation),
  }
}

class FakeWindow extends EventEmitter {
  focused: boolean

  constructor(focused: boolean) {
    super()
    this.focused = focused
  }

  isFocused(): boolean {
    return this.focused
  }

  focus(next: boolean): void {
    this.focused = next
    this.emit(next ? 'focus' : 'blur')
  }
}

describe('renderer focus binding', () => {
  it('seeds the focus of a window focused at creation', () => {
    const app = attention()
    const owner: RendererOwner = { id: 1, generation: 1 }
    bindRendererFocus(
      new FakeWindow(true),
      () => owner,
      (o, focused) => app.setOwnerFocused(o, focused),
    )

    expect(app.windowFocus.isFocused()).toBe(true)
  })

  it('keeps the window focused across a renderer reload of the sole focused window', () => {
    const app = attention()
    const win = new FakeWindow(true)
    const first: RendererOwner = { id: 1, generation: 1 }
    let owner = first
    const seed = bindRendererFocus(
      win,
      () => owner,
      (o, focused) => app.setOwnerFocused(o, focused),
    )

    owner = { id: 1, generation: 2 }
    seed()
    app.removeOwner(first)

    expect(app.windowFocus.isFocused()).toBe(true)
  })

  it('reports the replacement owner on later focus changes', () => {
    const app = attention()
    const win = new FakeWindow(true)
    const first: RendererOwner = { id: 1, generation: 1 }
    let owner = first
    const seed = bindRendererFocus(
      win,
      () => owner,
      (o, focused) => app.setOwnerFocused(o, focused),
    )
    owner = { id: 1, generation: 2 }
    seed()
    app.removeOwner(first)

    win.focus(false)
    expect(app.windowFocus.isFocused()).toBe(false)
    win.focus(true)
    expect(app.windowFocus.isFocused()).toBe(true)
  })

  it('stays away after a reload of an unfocused window', () => {
    const app = attention()
    const win = new FakeWindow(false)
    const first: RendererOwner = { id: 1, generation: 1 }
    let owner = first
    const seed = bindRendererFocus(
      win,
      () => owner,
      (o, focused) => app.setOwnerFocused(o, focused),
    )

    owner = { id: 1, generation: 2 }
    seed()
    app.removeOwner(first)

    expect(app.windowFocus.isFocused()).toBe(false)
  })
})
