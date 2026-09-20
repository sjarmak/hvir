/**
 * Wheel input over a terminal, as the desktop pane and the Companion mirror
 * both decide it: the viewport owns a normal-screen gesture, an alternate
 * screen program receives page keys, and a program tracking the mouse
 * receives SGR reports. Pure: no DOM, no emulator.
 *
 * What a gesture means is decided once here for every surface. What one step of
 * it costs in travel is not the same question, because the steps are not the
 * same size: a viewport step is a row, an SGR report is a notch of someone
 * else's scrolling, and a page key is the whole screen. A notch is a discrete
 * unit of intent and is read in lines whatever it drives; a drag is continuous
 * distance, so a page costs it half the rows it moves and dragging half a
 * screen moves a screen. The gesture says which it is: `deltaMode` cannot, since
 * Chrome reports pixel deltas for plain mouse wheels too.
 */
const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const LINES_PER_WHEEL_STEP = 3
const FALLBACK_CELL_HEIGHT = 16
const MAX_SGR_REPORTS_PER_NOTCH = 5

/** How the gesture was produced, which is what one step of travel costs. */
export type TerminalGesture = 'notch' | 'drag'

const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'

/**
 * The wheel reports this policy synthesizes for a scroll, and only those:
 * buttons 64 and 65 are wheel up and wheel down, a notch by construction rather
 * than a press at a position, and a phone gesture carries no modifier that could
 * raise the button past them. Every token starts with ESC, which is what lets a
 * batch of them be cut at a token boundary without parsing it.
 */
const READ_BACK_TOKEN = String.raw`\x1b\[(?:[56]~|<6[45];\d+;\d+M)`
const READ_BACK_ONE = new RegExp(`^${READ_BACK_TOKEN}$`)
const READ_BACK_BATCH = new RegExp(`^(?:${READ_BACK_TOKEN})+$`)
export const TERMINAL_READ_BACK_TOKEN_START = '\x1b'

/**
 * The complete output of this policy's routes for a read-back gesture: the page
 * keys an alternate-screen program receives, and the wheel reports a program
 * tracking the mouse receives. It is the closed set ADR-055 exempts from the
 * per-mirror arm and from the terminal input record, widened to the mouse route
 * by ADR-056, and it is defined by the routes rather than by a list beside them.
 */
export function isTerminalReadBackNavigation(data: string): boolean {
  return READ_BACK_ONE.test(data)
}

/**
 * One gesture's worth of that set: one or more tokens of it and nothing else,
 * in the order the policy produced them. A finger moves a program through its
 * history by many reports, and they travel as one ordered write rather than one
 * request each, which is what keeps them in the order the finger moved. A
 * batch is still inside the closed set, since it is made of nothing but it.
 */
export function isTerminalReadBackNavigationBatch(data: string): boolean {
  return READ_BACK_BATCH.test(data)
}

export interface TerminalWheelEvent {
  readonly gesture: TerminalGesture
  readonly deltaY: number
  readonly deltaMode: number
  readonly offsetX: number
  readonly offsetY: number
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
}

/**
 * A browser wheel event as one notch of this policy's own shape. The fields are
 * read out one by one rather than spread: they are prototype accessors on
 * `WheelEvent`, so a spread copies none of them.
 */
export function terminalWheelNotch(
  event: Omit<TerminalWheelEvent, 'gesture'>,
): TerminalWheelEvent {
  return {
    gesture: 'notch',
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    offsetX: event.offsetX,
    offsetY: event.offsetY,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
  }
}

export interface TerminalWheelState {
  readonly alternateScreen: boolean
  readonly mouseTracking: boolean
  readonly sgrMouse: boolean
  readonly cols: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
}

export interface TerminalWheelResult {
  readonly handled: boolean
  readonly data: readonly string[]
}

type WheelRoute = 'page' | 'sgr'

const unhandled: TerminalWheelResult = { handled: false, data: [] }
const consumed: TerminalWheelResult = { handled: true, data: [] }

/**
 * Translate browser wheel input into bounded terminal input.
 *
 * Browser trackpads emit a gesture as many fractional pixel events. Keep their
 * remainder across events so distance, rather than browser event frequency,
 * determines when the terminal receives another navigation action.
 */
export class TerminalWheelController {
  private route: WheelRoute | undefined
  private remainder = 0

  /**
   * The finger lifted, or the surface was sent home: whatever fraction of a
   * step it had banked belongs to that gesture and not to the next brush of
   * the grid, which would otherwise start with a report already owed.
   */
  endGesture(): void {
    this.route = undefined
    this.remainder = 0
  }

  handle(event: TerminalWheelEvent, state: TerminalWheelState): TerminalWheelResult {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return unhandled

    if (state.mouseTracking) {
      // SGR is the only mouse encoding we synthesize. Consuming unsupported
      // legacy modes is safer than injecting PageUp/PageDown or history arrows
      // into an application that explicitly requested mouse input.
      if (!state.sgrMouse) {
        this.endGesture()
        return consumed
      }

      const steps = this.consumeSteps(event, state, 'sgr')
      if (steps === 0) return consumed
      const { col, row } = wheelCell(event, state)
      const modifier =
        (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0)
      const button = (steps > 0 ? 65 : 64) + modifier
      const report = `\x1b[<${button};${col};${row}M`
      return {
        handled: true,
        data: Array.from({ length: Math.abs(steps) }, () => report),
      }
    }

    if (state.alternateScreen) {
      const steps = this.consumeSteps(event, state, 'page')
      if (steps === 0) return consumed
      return { handled: true, data: [steps > 0 ? PAGE_DOWN : PAGE_UP] }
    }

    // Normal-screen terminals own their local scrollback. Do not let a partial
    // alternate-screen gesture carry into a later mode change.
    this.endGesture()
    return unhandled
  }

  private consumeSteps(
    event: TerminalWheelEvent,
    state: TerminalWheelState,
    route: WheelRoute,
  ): number {
    if (this.route !== route) {
      this.remainder = 0
      this.route = route
    }

    const delta = normalizedWheelDelta(
      event,
      state.cellHeight,
      stepCells(event, state, route),
    )
    if (this.remainder !== 0 && Math.sign(this.remainder) !== Math.sign(delta)) {
      this.remainder = 0
    }

    const total = this.remainder + delta
    const wholeSteps = Math.trunc(total)
    if (wholeSteps === 0) {
      this.remainder = total
      return 0
    }

    const limit = route === 'page' ? 1 : sgrReportLimit(event, state)
    const steps = clampSteps(wholeSteps, limit)
    // Bank the steps this event may not carry, along with the sub-step
    // fraction, so how far a gesture travels follows the distance it covered
    // rather than how the browser batched it into events. The bank is itself
    // one event's worth: a source producing faster than the policy will deliver
    // is rate limited rather than queued, which is what bounds a very large
    // synthetic or accelerated delta.
    this.remainder = clampSteps(wholeSteps - steps, limit) + (total - wholeSteps)
    return steps
  }
}

function clampSteps(steps: number, limit: number): number {
  return Math.max(-limit, Math.min(steps, limit))
}

/**
 * Reports one event may carry on the SGR route. A wheel produces many events
 * for one gesture and a program scrolling by report keeps up with a few per
 * event, so a notch is held to a few. A finger produces one event per move and
 * its travel is the whole scroll, so a drag carries every report its distance
 * earned, up to a screen of them: no finger crosses more than a screen in one
 * move, and the bound is what keeps a synthetic delta from running away.
 */
function sgrReportLimit(event: TerminalWheelEvent, state: TerminalWheelState): number {
  if (event.gesture === 'notch') return MAX_SGR_REPORTS_PER_NOTCH
  const rows = Number.isFinite(state.rows) ? Math.trunc(state.rows) : 0
  return Math.max(MAX_SGR_REPORTS_PER_NOTCH, rows)
}

/**
 * Cells of travel one step costs. A notch is three lines of intent whatever it
 * drives, and an SGR report stands for a notch rather than for a screen, so it
 * is three lines under a finger too. A page key is the whole screen, so a drag
 * pays half the rows it moves for one and never less than a notch would.
 */
function stepCells(
  event: TerminalWheelEvent,
  state: TerminalWheelState,
  route: WheelRoute,
): number {
  if (event.gesture === 'notch' || route === 'sgr') return LINES_PER_WHEEL_STEP
  const rows = Number.isFinite(state.rows) ? Math.trunc(state.rows) : 0
  return Math.max(LINES_PER_WHEEL_STEP, Math.floor(rows / 2))
}

function normalizedWheelDelta(
  event: TerminalWheelEvent,
  cellHeight: number,
  stepCells: number,
): number {
  switch (event.deltaMode) {
    case DOM_DELTA_PAGE:
      return event.deltaY
    case DOM_DELTA_LINE:
      return event.deltaY / stepCells
    case DOM_DELTA_PIXEL:
    default: {
      const rowHeight =
        Number.isFinite(cellHeight) && cellHeight > 0 ? cellHeight : FALLBACK_CELL_HEIGHT
      return event.deltaY / (rowHeight * stepCells)
    }
  }
}

function wheelCell(
  event: Pick<TerminalWheelEvent, 'offsetX' | 'offsetY'>,
  state: Pick<TerminalWheelState, 'cols' | 'rows' | 'cellWidth' | 'cellHeight'>,
): { col: number; row: number } {
  const cellWidth =
    Number.isFinite(state.cellWidth) && state.cellWidth > 0 ? state.cellWidth : 1
  const cellHeight =
    Number.isFinite(state.cellHeight) && state.cellHeight > 0
      ? state.cellHeight
      : FALLBACK_CELL_HEIGHT
  const col =
    Math.floor((Number.isFinite(event.offsetX) ? event.offsetX : 0) / cellWidth) + 1
  const row =
    Math.floor((Number.isFinite(event.offsetY) ? event.offsetY : 0) / cellHeight) + 1
  const cols = Math.max(1, Math.trunc(state.cols))
  const rows = Math.max(1, Math.trunc(state.rows))
  return {
    col: Math.max(1, Math.min(col, cols)),
    row: Math.max(1, Math.min(row, rows)),
  }
}
