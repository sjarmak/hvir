/**
 * The mirror's text layers (ADR-050): what the page lays out from the
 * emulator's rows, beside or instead of the grid. The reflow view shows the
 * screen and scrollback as lines wrapped to the phone's width, so a wide
 * desktop grid reads at a readable size and scrolls like a document; the
 * fit-width view draws the scrollback as rows above the grid, at the grid's
 * cell metrics, so the area shows history and the live screen as one column.
 * The emulator keeps the desktop's grid underneath; only what the person
 * reads changes. Output refreshes a layer a bounded number of times a second,
 * and a view that was at the newest line stays there.
 */
import type { CompanionBufferLine } from './companion-terminal-pane'

/** Rows read from the emulator's end for reflow; enough scrollback to read back through a turn. */
export const REFLOW_LINE_LIMIT = 2000
/** Scrollback rows drawn above the grid in fit-width. */
export const HISTORY_LINE_LIMIT = 1000
/** Output frames arrive many times a second; a layer is rebuilt at most this often. */
export const REFLOW_REFRESH_MS = 80
/** Within this many pixels of the end counts as reading the newest line. */
const FOLLOW_SLACK_PX = 24

/**
 * Logical lines from buffer rows: a wrapped row continues the row before it
 * (the emulator broke it at the desktop's width, which the phone need not
 * keep), each line loses its trailing blanks, and blank lines at the end are
 * dropped so the text ends where the output does.
 */
export function reflowText(lines: readonly CompanionBufferLine[]): string {
  const logical: string[] = []
  for (const line of lines) {
    if (line.wrapped && logical.length > 0) {
      logical[logical.length - 1] += line.text
    } else {
      logical.push(line.text)
    }
  }
  const trimmed = logical.map((line) => line.trimEnd())
  let end = trimmed.length
  while (end > 0 && trimmed[end - 1] === '') end -= 1
  return trimmed.slice(0, end).join('\n')
}

/** Rows as the grid holds them, one per line at the desktop's width, for the history above it. */
export function historyText(lines: readonly CompanionBufferLine[]): string {
  return lines.map((line) => line.text).join('\n')
}

export interface MirrorTextOptions {
  /** The box that scrolls over the text; a view at its end is kept at its end. */
  readonly scroller: HTMLElement
  /** The element the text is written into. */
  readonly text: HTMLElement
  readonly source: () => readonly CompanionBufferLine[]
  readonly format: (lines: readonly CompanionBufferLine[]) => string
  /** Runs after the text changed and before the end is followed: the scroller's extent may size itself. */
  readonly afterRefresh?: () => void
}

export class MirrorText {
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(private readonly options: MirrorTextOptions) {}

  /** A refresh soon; several requests in one interval make one refresh. */
  schedule(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.refresh()
    }, REFLOW_REFRESH_MS)
  }

  /** Rebuilds the text now and keeps a view at the end at the end. */
  refresh(): void {
    if (this.disposed) return
    const { scroller, text, source, format, afterRefresh } = this.options
    const following =
      scroller.scrollTop + scroller.clientHeight >=
      scroller.scrollHeight - FOLLOW_SLACK_PX
    text.textContent = format(source())
    afterRefresh?.()
    if (following) scroller.scrollTop = scroller.scrollHeight
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
