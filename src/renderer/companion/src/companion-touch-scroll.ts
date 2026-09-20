/**
 * A finger over the mirror's grid, adapted into the event shape the shared
 * wheel policy already decides (ADR-053). The page grows no second policy for
 * touch: one gesture is described once here, and what it means is settled
 * where a wheel notch's meaning is settled. What it carries that a notch does
 * not is that it is a drag, which the policy reads to decide how much travel
 * one step costs rather than what the step is.
 *
 * Two facts about the surface shape the adapter. Touch deltas arrive in
 * on-screen pixels while the emulator's cell metrics are its own unscaled
 * pixels, and the mount draws the grid under a CSS transform, so every delta
 * is divided by that scale before it leaves here or the content crawls at a
 * fraction of the finger's speed. And ghostty-web registers its own `touchend`
 * on the canvas that focuses the hidden textarea unconditionally, which on a
 * phone raises the soft keyboard, resizes the viewport, and asks the desktop
 * for a new grid while Away. The whole gesture is therefore owned here, in the
 * capture phase, and every `touchend` over the grid is stopped before it
 * reaches the canvas: the mirror's typing surface is its own control bar, the
 * emulator is built to hold no focus, and nothing over the grid wants to give
 * it any. The touch events are also cancelled, which is what stops the browser
 * following a tap with the mouse events it synthesizes for a page that never
 * asked for touch: ghostty-web's canvas `mousedown` focuses that same textarea,
 * and a press it hears while the mirror is armed is a report of its own.
 *
 * The lift of the finger ends the gesture, and the pane is told so: the policy
 * banks the fraction of a step a slow drag has not yet paid for, and that bank
 * belongs to the drag it came from rather than to the next brush of the grid.
 */
import type { TerminalWheelEvent } from '../../../shared'

export interface CompanionTouchScrollOptions {
  /** The box the emulator draws in; the gesture is owned here and nowhere else. */
  readonly element: HTMLElement
  /** The surface's current transform scale, which on-screen pixels are divided by. */
  readonly scale: () => number
  /** Where the movement goes, already in the emulator's own pixels. */
  readonly sink: (event: TerminalWheelEvent) => void
  /** The primary finger lifted or the gesture was cancelled; the pane drops what it banked. */
  readonly end: () => void
}

/** Owned in the capture phase and cancellable, so `preventDefault` is honoured. */
const LISTEN: AddEventListenerOptions = { capture: true, passive: false }
const UNLISTEN: EventListenerOptions = { capture: true }

interface TouchPoint {
  readonly identifier: number
  readonly clientX: number
  readonly clientY: number
}

export class CompanionTouchScroll {
  private identifier?: number
  private lastY = 0
  private readonly listeners: Array<[string, (event: Event) => void]>

  constructor(private readonly options: CompanionTouchScrollOptions) {
    this.listeners = [
      ['touchstart', (event) => this.start(event)],
      ['touchmove', (event) => this.move(event)],
      ['touchend', (event) => this.end(event)],
      ['touchcancel', (event) => this.cancel(event)],
    ]
    for (const [type, listener] of this.listeners) {
      options.element.addEventListener(type, listener, LISTEN)
    }
  }

  dispose(): void {
    for (const [type, listener] of this.listeners) {
      this.options.element.removeEventListener(type, listener, UNLISTEN)
    }
    this.identifier = undefined
  }

  /** One primary touch at a time: a second finger is ignored until the first ends. */
  private start(event: Event): void {
    event.preventDefault()
    if (this.identifier !== undefined) return
    const touch = changedTouches(event)[0]
    if (touch === undefined) return
    this.identifier = touch.identifier
    this.lastY = touch.clientY
  }

  private move(event: Event): void {
    event.preventDefault()
    const touch = this.tracked(event)
    if (touch === undefined) return
    const screenDelta = this.lastY - touch.clientY
    this.lastY = touch.clientY
    if (screenDelta === 0) return
    const scale = this.options.scale()
    const bounds = this.options.element.getBoundingClientRect()
    this.options.sink({
      // A finger is continuous distance, not a notch of intent, which is what
      // decides the travel one page key costs (ADR-053's one policy, ADR-055's
      // page keys).
      gesture: 'drag',
      deltaY: screenDelta / scale,
      deltaMode: 0,
      offsetX: (touch.clientX - bounds.left) / scale,
      offsetY: (touch.clientY - bounds.top) / scale,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    })
  }

  /**
   * Every touch over the grid ends here rather than at the canvas, so the
   * emulator's own handler never focuses its textarea, whichever finger lifted
   * and whether or not the gesture moved. The primary touch lifting is also
   * what ends the gesture.
   */
  private end(event: Event): void {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (this.tracked(event) !== undefined) this.forget()
  }

  /** The browser took the touch back; the gesture ends the way a lift ends it. */
  private cancel(event: Event): void {
    if (this.tracked(event) !== undefined) this.forget()
  }

  private tracked(event: Event): TouchPoint | undefined {
    if (this.identifier === undefined) return undefined
    return changedTouches(event).find((touch) => touch.identifier === this.identifier)
  }

  private forget(): void {
    this.identifier = undefined
    this.options.end()
  }
}

function changedTouches(event: Event): readonly TouchPoint[] {
  const touches = (event as { changedTouches?: ArrayLike<TouchPoint> }).changedTouches
  return touches === undefined ? [] : Array.from(touches)
}
