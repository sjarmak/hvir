/**
 * The mirror's scrollback layer (ADR-050): the rows before the screen's own,
 * drawn as text above the grid at the grid's cell metrics, so the area shows
 * history and the live screen as one column. The emulator keeps the desktop's
 * grid underneath; only what the person reads back through changes. Output
 * refreshes the text a bounded number of times a second, and a view that was
 * at the newest line stays there.
 */
import type { CompanionBufferLine } from './companion-terminal-pane'

/** Scrollback rows drawn above the grid: enough to read back through a turn. */
export const HISTORY_LINE_LIMIT = 1000
/** Output frames arrive many times a second; the text is rebuilt at most this often. */
export const HISTORY_REFRESH_MS = 80
/** Within this many pixels of the end counts as reading the newest line. */
const FOLLOW_SLACK_PX = 24

/** Rows as the grid holds them, one per line at the desktop's width. */
export function historyText(lines: readonly CompanionBufferLine[]): string {
  return lines.map((line) => line.text).join('\n')
}

export interface MirrorHistoryOptions {
  /** The box that scrolls over the column; a view at its end is kept at its end. */
  readonly scroller: HTMLElement
  /** The element the text is written into. */
  readonly text: HTMLElement
  readonly source: () => readonly CompanionBufferLine[]
  /** Runs after the text changed and before the end is followed: the column may size itself. */
  readonly afterRefresh: () => void
}

export class MirrorHistory {
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(private readonly options: MirrorHistoryOptions) {}

  /** A refresh soon; several requests in one interval make one refresh. */
  schedule(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.refresh()
    }, HISTORY_REFRESH_MS)
  }

  /** Rebuilds the text now and keeps a view at the end at the end. */
  refresh(): void {
    if (this.disposed) return
    const { scroller, text, source, afterRefresh } = this.options
    const following =
      scroller.scrollTop + scroller.clientHeight >=
      scroller.scrollHeight - FOLLOW_SLACK_PX
    text.textContent = historyText(source())
    afterRefresh()
    if (following) scroller.scrollTop = scroller.scrollHeight
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
