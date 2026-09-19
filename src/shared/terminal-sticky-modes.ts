/**
 * The terminal modes a replayed window of output can no longer prove, held
 * beside it (ADR-054).
 *
 * Every reader of a live PTY starts from a window: the desktop renderer takes
 * the retained replay when it attaches, a mirror takes the retained tail, and
 * the phone's own buffer re-cuts that tail on every remount. Each window is cut
 * at whichever character its budget lands on, so the alternate-screen enter a
 * full-screen program emits once at startup falls out of it long before the
 * session ends, and the replay paints onto the normal screen while the session
 * is on the alternate one. This scanner reads the same characters and keeps,
 * for a closed set of DEC private modes, the last set or reset it saw and the
 * position in the stream where that transition sits.
 *
 * The position is half the answer. A preamble that asserts a mode the window
 * still carries puts the emulator on the alternate screen before the characters
 * that belong on the normal one are written, and the scrollback they would have
 * rebuilt is lost instead. So `preamble` is asked how long the window is and
 * names only the modes whose last transition falls before the window begins.
 * Inside it the characters speak for themselves.
 *
 * The scan is mechanical and bounded. It builds no screen, no cursor and no cell
 * grid, and it reads no content: every character outside a private mode sequence
 * crosses unexamined, as ADR-050 requires. A sequence split across two reads is
 * carried as parse state rather than as text, so no window of the stream is held
 * and the split changes no outcome.
 */

const ESCAPE = '\u001b'
/** What a DEC private mode set or reset opens with; the scan's only anchor. */
const PRIVATE_MODE_PREFIX = `${ESCAPE}[?`

interface CarriedMode {
  /** The number the preamble emits for this mode. */
  readonly emitted: number
  /** The numbers in the stream that reach it. */
  readonly observed: readonly number[]
}

/**
 * The carried set, in emission order. `?1049` is emitted first so its cursor
 * save happens against the normal screen, the way the program that wrote it ran
 * it. `?1047` names the same alternate buffer as `?47`, so it is observed as
 * `?47`: the two differ in what their resets clear, and this scanner emits no
 * reset. Every other mode is left to the window, for reasons ADR-054 states.
 */
const CARRIED_MODES: readonly CarriedMode[] = [
  { emitted: 1049, observed: [1049] },
  { emitted: 47, observed: [47, 1047] },
]

const LARGEST_OBSERVED_MODE = Math.max(
  ...CARRIED_MODES.flatMap((mode) => [...mode.observed]),
)

function setSequence(mode: number): string {
  return `${PRIVATE_MODE_PREFIX}${mode}h`
}

/** The width of a preamble with every carried mode set; a wire bound, not an estimate. */
export const STICKY_MODE_PREAMBLE_MAX_CHARS = CARRIED_MODES.reduce(
  (total, mode) => total + setSequence(mode.emitted).length,
  0,
)

/** One parameter of a sequence, read a digit at a time so nothing accumulates. */
interface Parameter {
  readonly seen: boolean
  readonly value: number
  /** Set once the value passes the largest carried mode, which it can only grow past. */
  readonly beyond: boolean
}

const EMPTY_PARAMETER: Parameter = { seen: false, value: 0, beyond: false }

type Scan =
  | { readonly kind: 'text' }
  /** Inside the prefix, with `matched` of its characters behind us. */
  | { readonly kind: 'prefix'; readonly start: number; readonly matched: number }
  /** Past the prefix, reading parameters; `carried` is the subset worth keeping. */
  | {
      readonly kind: 'parameters'
      readonly start: number
      readonly carried: readonly number[]
      readonly parameter: Parameter
    }

const TEXT: Scan = { kind: 'text' }

/** The last transition of one carried mode, and where in the stream it sits. */
interface Transition {
  readonly set: boolean
  readonly start: number
}

export class TerminalStickyModes {
  private readonly transitions = new Map<number, Transition>()
  private scan: Scan = TEXT
  private position = 0

  /** Fed the same characters as the window it stands beside, in stream order. */
  retain(chunk: string): void {
    const base = this.position
    let index = 0
    while (index < chunk.length) index = this.step(chunk, index, base)
    this.position = base + chunk.length
  }

  /**
   * The carried modes the last `windowChars` characters of the stream no longer
   * prove, as the sets that reach them. A window longer than the stream proves
   * everything and answers empty.
   */
  preamble(windowChars: number): string {
    const windowStart = Math.max(0, this.position - windowChars)
    let preamble = ''
    for (const mode of CARRIED_MODES) {
      const transition = this.transitions.get(mode.emitted)
      if (transition?.set === true && transition.start < windowStart) {
        preamble += setSequence(mode.emitted)
      }
    }
    return preamble
  }

  clear(): void {
    this.transitions.clear()
    this.scan = TEXT
    this.position = 0
  }

  /**
   * Advances past at least one character and returns where the next step begins.
   * Outside a sequence it jumps straight to the next escape, so the cost of a chunk
   * that carries none is one search rather than one comparison per character.
   */
  private step(chunk: string, index: number, base: number): number {
    const scan = this.scan
    if (scan.kind === 'parameters') return this.readParameter(chunk, index, base, scan)
    if (scan.kind === 'prefix') return this.readPrefix(chunk, index, base, scan)
    const escape = chunk.indexOf(ESCAPE, index)
    if (escape < 0) return chunk.length
    this.scan = { kind: 'prefix', start: base + escape, matched: 1 }
    return escape + 1
  }

  private readPrefix(
    chunk: string,
    index: number,
    base: number,
    scan: Extract<Scan, { kind: 'prefix' }>,
  ): number {
    if (chunk.charAt(index) !== PRIVATE_MODE_PREFIX.charAt(scan.matched)) {
      return this.restart(chunk, index, base)
    }
    const matched = scan.matched + 1
    this.scan =
      matched === PRIVATE_MODE_PREFIX.length
        ? {
            kind: 'parameters',
            start: scan.start,
            carried: [],
            parameter: EMPTY_PARAMETER,
          }
        : { kind: 'prefix', start: scan.start, matched }
    return index + 1
  }

  private readParameter(
    chunk: string,
    index: number,
    base: number,
    scan: Extract<Scan, { kind: 'parameters' }>,
  ): number {
    const character = chunk.charAt(index)
    if (character >= '0' && character <= '9') {
      this.scan = { ...scan, parameter: withDigit(scan.parameter, character) }
      return index + 1
    }
    if (character === ';') {
      this.scan = { ...scan, carried: withParameter(scan), parameter: EMPTY_PARAMETER }
      return index + 1
    }
    if (character !== 'h' && character !== 'l') return this.restart(chunk, index, base)
    const set = character === 'h'
    for (const mode of withParameter(scan)) {
      this.transitions.set(mode, { set, start: scan.start })
    }
    this.scan = TEXT
    return index + 1
  }

  /** Abandons the sequence in progress; an escape here opens the next one. */
  private restart(chunk: string, index: number, base: number): number {
    this.scan =
      chunk.charAt(index) === ESCAPE
        ? { kind: 'prefix', start: base + index, matched: 1 }
        : TEXT
    return index + 1
  }
}

function withDigit(parameter: Parameter, character: string): Parameter {
  if (parameter.beyond) return parameter
  const value = parameter.value * 10 + Number(character)
  return { seen: true, value, beyond: value > LARGEST_OBSERVED_MODE }
}

/** The carried set of a sequence, extended by the parameter just finished. */
function withParameter(scan: Extract<Scan, { kind: 'parameters' }>): readonly number[] {
  const { parameter } = scan
  if (!parameter.seen || parameter.beyond) return scan.carried
  const mode = CARRIED_MODES.find((carried) => carried.observed.includes(parameter.value))
  return mode === undefined ? scan.carried : [...scan.carried, mode.emitted]
}
