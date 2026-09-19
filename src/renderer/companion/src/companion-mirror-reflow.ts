/**
 * The mirror as a page of text (ADR-050, the reflow view): the emulator's
 * screen and scrollback read as lines and laid out at the phone's width, so
 * a wide desktop grid reads at a readable size and scrolls like a document.
 * The emulator keeps the desktop's grid underneath; only what the person
 * reads changes. Output refreshes the text a bounded number of times a
 * second, and a view that was at the newest line stays there.
 */
import type { CompanionBufferLine } from './companion-terminal-pane'

/** Rows read from the emulator's end; enough scrollback to read back through a turn. */
export const REFLOW_LINE_LIMIT = 2000
/** Output frames arrive many times a second; the text is rebuilt at most this often. */
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

export class MirrorReflow {
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  /**
   * The text sits in a child of the scrolling page so it can be pinned to
   * the page's bottom edge while it is shorter than the page: the newest
   * line is always just above the controls, as in a terminal, and the text
   * fills the area from the bottom up.
   */
  private readonly text: HTMLElement

  constructor(
    private readonly element: HTMLElement,
    private readonly source: () => readonly CompanionBufferLine[],
  ) {
    this.text = document.createElement('span')
    this.text.className = 'companion-terminal-reflow-text'
    element.replaceChildren(this.text)
  }

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
    const { element } = this
    const following =
      element.scrollTop + element.clientHeight >= element.scrollHeight - FOLLOW_SLACK_PX
    this.text.textContent = reflowText(this.source())
    if (following) element.scrollTop = element.scrollHeight
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
