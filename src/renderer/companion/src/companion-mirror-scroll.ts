/**
 * A finger over the mirror moves the reader's view of the terminal, never the
 * page (ADR-050: the grid is the desktop's; the phone only reads it). Pixels
 * become whole rows through the row's height on screen, with the fractional
 * remainder carried to the next event, so distance decides how far the view
 * moves rather than how many events the browser fires. What a row means is
 * the pane's decision (the scrollback viewport, or the keys a full-screen
 * program reads); wheel input never comes here, the pane takes it itself.
 */
export interface MirrorScrollDistance {
  readonly lines: number
  /** The fraction of a row not yet spent, in rows. */
  readonly remainder: number
}

/** Displacement on either axis past which a touch was a gesture, not a tap. */
const TAP_THRESHOLD_PX = 8

/**
 * Whole rows for `deltaPx` (positive scrolls down, toward live output). A
 * change of direction drops the carried fraction, and a grid with no layout
 * yet moves nothing.
 */
export function consumeScrollDistance(
  remainder: number,
  deltaPx: number,
  rowHeight: number,
): MirrorScrollDistance {
  if (!(rowHeight > 0) || !Number.isFinite(deltaPx) || deltaPx === 0) {
    return { lines: 0, remainder }
  }
  const carried = Math.sign(remainder) === Math.sign(deltaPx) ? remainder : 0
  const total = carried + deltaPx / rowHeight
  const lines = Math.trunc(total)
  return { lines, remainder: total - lines }
}

export interface MirrorScrollTarget {
  /** One grid row's height on screen in CSS pixels; 0 while the grid has no layout. */
  rowHeight(): number
  scrollLines(lines: number): void
}

interface Drag {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly lastY: number
  readonly remainder: number
  /** The finger travelled past the tap threshold, or the browser took the gesture. */
  readonly moved: boolean
  readonly ended: boolean
}

/**
 * Listens on the terminal host. A touch or pen drag scrolls by rows in the
 * direction of the finger and holds the pointer, so leaving the host box mid
 * drag keeps scrolling; a mouse drag is left to the emulator's selection.
 * The touchend that closes a gesture (a drag, a sideways pan, a pointer the
 * browser cancelled for its own scrolling) is stopped before it reaches the
 * emulator's canvas, which would take it for a tap and raise the phone's
 * keyboard; a tap still passes through.
 */
export class MirrorScrollGestures {
  private drag?: Drag

  constructor(
    private readonly host: HTMLElement,
    private readonly target: MirrorScrollTarget,
  ) {
    host.addEventListener('pointerdown', this.onPointerDown)
    host.addEventListener('pointermove', this.onPointerMove)
    host.addEventListener('pointerup', this.onPointerUp)
    host.addEventListener('pointercancel', this.onPointerCancel)
    host.addEventListener('touchend', this.onTouchEnd, { capture: true })
    host.addEventListener('touchcancel', this.onTouchEnd, { capture: true })
  }

  dispose(): void {
    const { host } = this
    host.removeEventListener('pointerdown', this.onPointerDown)
    host.removeEventListener('pointermove', this.onPointerMove)
    host.removeEventListener('pointerup', this.onPointerUp)
    host.removeEventListener('pointercancel', this.onPointerCancel)
    host.removeEventListener('touchend', this.onTouchEnd, { capture: true })
    host.removeEventListener('touchcancel', this.onTouchEnd, { capture: true })
    this.drag = undefined
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
    this.host.setPointerCapture(event.pointerId)
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      remainder: 0,
      moved: false,
      ended: false,
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag
    if (drag === undefined || drag.ended || drag.pointerId !== event.pointerId) return
    const { lines, remainder } = consumeScrollDistance(
      drag.remainder,
      drag.lastY - event.clientY,
      this.target.rowHeight(),
    )
    if (lines !== 0) this.target.scrollLines(lines)
    this.drag = {
      ...drag,
      lastY: event.clientY,
      remainder,
      moved:
        drag.moved ||
        Math.abs(event.clientX - drag.startX) > TAP_THRESHOLD_PX ||
        Math.abs(event.clientY - drag.startY) > TAP_THRESHOLD_PX,
    }
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.end(event, false)
  }

  /** The browser took the touch for its own gesture: never a tap. */
  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.end(event, true)
  }

  private end(event: PointerEvent, moved: boolean): void {
    const drag = this.drag
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    if (this.host.hasPointerCapture(event.pointerId)) {
      this.host.releasePointerCapture(event.pointerId)
    }
    this.drag = { ...drag, ended: true, moved: drag.moved || moved }
  }

  private readonly onTouchEnd = (event: TouchEvent): void => {
    if (this.drag?.moved === true) {
      event.stopPropagation()
      // Once the browser classified the touch as a scroll the event is no
      // longer cancelable, and stopping it is what keeps the canvas from it.
      if (event.cancelable) event.preventDefault()
    }
    this.drag = undefined
  }
}
