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
 * phone raises the soft keyboard and resizes the viewport. The whole gesture is
 * therefore owned here, in the capture phase, and every `touchend` over the
 * grid is stopped before it reaches the canvas: the mirror's typing surface is
 * its own control bar, the emulator is built to hold no focus, and nothing over
 * the grid wants to give it any. The touch events are also cancelled, which is
 * what stops the browser following a tap with the mouse events it synthesizes
 * for a page that never asked for touch: ghostty-web's canvas `mousedown`
 * focuses that same textarea, and a press it hears while the mirror is armed is
 * a report of its own.
 *
 * Owning the touch also forfeits the browser's momentum, which a desktop
 * trackpad has from the OS: a flick there keeps scrolling after the fingers
 * lift, and one over the grid would stop dead. So a lift with speed behind it
 * becomes a fling, which goes on moving the content frame by frame as the same
 * drag, slowing the way a scroll view slows, until it rests or a finger lands.
 * The gesture ends when the fling rests, or at the lift when there was none,
 * and the pane is told so: the policy banks the fraction of a step a slow drag
 * has not yet paid for, and that bank belongs to the drag it came from rather
 * than to the next brush of the grid.
 */
import type { TerminalWheelEvent } from '../../../shared'

/** Frames for a fling: `requestAnimationFrame` on a phone, a pump in a test. */
export interface CompanionFrameScheduler {
  request(callback: (now: number) => void): number
  cancel(handle: number): void
}

export interface CompanionTouchScrollOptions {
  /** The box the emulator draws in; the gesture is owned here and nowhere else. */
  readonly element: HTMLElement
  /** The surface's current transform scale, which on-screen pixels are divided by. */
  readonly scale: () => number
  /** Where the movement goes, already in the emulator's own pixels. */
  readonly sink: (event: TerminalWheelEvent) => void
  /** The gesture is over, fling included, or was cancelled; the pane drops what it banked. */
  readonly end: () => void
  /** The clock the finger's speed is read on; the document's by default. */
  readonly now?: () => number
  /** Where a fling's frames come from; the window's animation frames by default. */
  readonly frames?: CompanionFrameScheduler
}

/** Owned in the capture phase and cancellable, so `preventDefault` is honoured. */
const LISTEN: AddEventListenerOptions = { capture: true, passive: false }
const UNLISTEN: EventListenerOptions = { capture: true }

/** How far back the lift looks to read the finger's speed. */
const VELOCITY_WINDOW_MS = 100
/** A lift slower than this, in on-screen pixels per millisecond, is a stop and not a flick. */
const FLING_MIN_VELOCITY = 0.3
/** A fling has rested once it is slower than this. */
const FLING_REST_VELOCITY = 0.02
/** The speed left after each millisecond, the deceleration a scroll view uses. */
const FLING_DECAY_PER_MS = 0.998
/** A frame that took longer than this, a hidden tab's for one, moves as if it took this long. */
const MAX_FRAME_MS = 64

interface TouchPoint {
  readonly identifier: number
  readonly clientX: number
  readonly clientY: number
}

interface Sample {
  readonly at: number
  readonly clientY: number
}

interface Fling {
  /** On-screen pixels per millisecond, signed as the finger moved. */
  velocity: number
  lastAt: number
  handle: number
}

export class CompanionTouchScroll {
  private identifier?: number
  private lastX = 0
  private lastY = 0
  private samples: Sample[] = []
  private fling?: Fling
  private readonly now: () => number
  private readonly frames: CompanionFrameScheduler
  private readonly listeners: Array<[string, (event: Event) => void]>

  constructor(private readonly options: CompanionTouchScrollOptions) {
    this.now = options.now ?? (() => performance.now())
    this.frames = options.frames ?? {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
    }
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
    this.stopFling()
    this.identifier = undefined
  }

  /**
   * One primary touch at a time: a second finger is ignored until the first
   * ends. A finger landing on a fling catches it, which ends that gesture.
   */
  private start(event: Event): void {
    event.preventDefault()
    if (this.identifier !== undefined) return
    const touch = changedTouches(event)[0]
    if (touch === undefined) return
    if (this.fling !== undefined) {
      this.stopFling()
      this.options.end()
    }
    this.identifier = touch.identifier
    this.lastX = touch.clientX
    this.lastY = touch.clientY
    this.samples = [{ at: this.now(), clientY: touch.clientY }]
  }

  private move(event: Event): void {
    event.preventDefault()
    const touch = this.tracked(event)
    if (touch === undefined) return
    const screenDelta = this.lastY - touch.clientY
    this.lastX = touch.clientX
    this.lastY = touch.clientY
    this.sample(touch.clientY)
    if (screenDelta === 0) return
    this.emit(screenDelta)
  }

  /**
   * Every touch over the grid ends here rather than at the canvas, so the
   * emulator's own handler never focuses its textarea, whichever finger lifted
   * and whether or not the gesture moved. The primary touch lifting is also
   * what ends the drag, into a fling when it lifted with speed.
   */
  private end(event: Event): void {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (this.tracked(event) === undefined) return
    const velocity = this.liftVelocity()
    this.forget()
    if (Math.abs(velocity) < FLING_MIN_VELOCITY) {
      this.options.end()
      return
    }
    this.fling = { velocity, lastAt: this.now(), handle: 0 }
    this.fling.handle = this.frames.request((now) => this.flingFrame(now))
  }

  /** The browser took the touch back; the gesture ends the way a still lift ends it. */
  private cancel(event: Event): void {
    if (this.tracked(event) === undefined) return
    this.forget()
    this.options.end()
  }

  private tracked(event: Event): TouchPoint | undefined {
    if (this.identifier === undefined) return undefined
    return changedTouches(event).find((touch) => touch.identifier === this.identifier)
  }

  private forget(): void {
    this.identifier = undefined
    this.samples = []
  }

  /** The finger's recent positions, kept for as long as the lift looks back. */
  private sample(clientY: number): void {
    const at = this.now()
    this.samples = this.samples.filter((sample) => at - sample.at <= VELOCITY_WINDOW_MS)
    this.samples.push({ at, clientY })
  }

  /**
   * On-screen pixels per millisecond over the window before the lift, signed
   * as the content moves: a finger toward the top of the screen reads forward.
   * A finger that paused before lifting has no sample in the window but the one
   * it rested on, and so no speed; two samples in the same instant say nothing.
   */
  private liftVelocity(): number {
    const at = this.now()
    const recent = this.samples.filter((sample) => at - sample.at <= VELOCITY_WINDOW_MS)
    const first = recent[0]
    const last = recent[recent.length - 1]
    if (first === undefined || last === undefined || last.at <= first.at) return 0
    return (first.clientY - last.clientY) / (last.at - first.at)
  }

  private flingFrame(now: number): void {
    const fling = this.fling
    if (fling === undefined) return
    const elapsed = Math.min(MAX_FRAME_MS, Math.max(0, now - fling.lastAt))
    fling.lastAt = now
    this.emit(fling.velocity * elapsed)
    fling.velocity *= FLING_DECAY_PER_MS ** elapsed
    if (Math.abs(fling.velocity) < FLING_REST_VELOCITY) {
      this.fling = undefined
      this.options.end()
      return
    }
    fling.handle = this.frames.request((next) => this.flingFrame(next))
  }

  private stopFling(): void {
    if (this.fling === undefined) return
    this.frames.cancel(this.fling.handle)
    this.fling = undefined
  }

  /** One movement of the content, in on-screen pixels, as the policy's drag event. */
  private emit(screenDelta: number): void {
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
      offsetX: (this.lastX - bounds.left) / scale,
      offsetY: (this.lastY - bounds.top) / scale,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    })
  }
}

function changedTouches(event: Event): readonly TouchPoint[] {
  const touches = (event as { changedTouches?: ArrayLike<TouchPoint> }).changedTouches
  return touches === undefined ? [] : Array.from(touches)
}
