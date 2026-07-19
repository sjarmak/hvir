export interface TerminalMouseButtonEvent {
  readonly button: number
  readonly offsetX: number
  readonly offsetY: number
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
}

export interface TerminalMouseState {
  readonly mouseTracking: boolean
  readonly sgrMouse: boolean
  readonly cols: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
}

export interface TerminalMouseResult {
  readonly handled: boolean
  readonly data?: string
}

type TerminalMousePhase = 'press' | 'release'

const unhandled: TerminalMouseResult = { handled: false }
const consumed: TerminalMouseResult = { handled: true }

/** Translate a browser mouse button into the SGR protocol requested by a terminal app. */
export function terminalMouseButton(
  phase: TerminalMousePhase,
  event: TerminalMouseButtonEvent,
  state: TerminalMouseState,
): TerminalMouseResult {
  if (!state.mouseTracking || event.button < 0 || event.button > 2) return unhandled
  if (!state.sgrMouse) return consumed

  const modifier =
    (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0)
  const col = Math.max(
    1,
    Math.min(state.cols, Math.floor(event.offsetX / state.cellWidth) + 1),
  )
  const row = Math.max(
    1,
    Math.min(state.rows, Math.floor(event.offsetY / state.cellHeight) + 1),
  )
  const suffix = phase === 'press' ? 'M' : 'm'
  return {
    handled: true,
    data: `\x1b[<${event.button + modifier};${col};${row}${suffix}`,
  }
}
