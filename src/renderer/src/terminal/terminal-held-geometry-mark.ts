import type { TerminalSize } from './terminal-pane'

/**
 * What a pane wears while another client holds its size (ADR-058): the blank
 * remainder outside the held grid takes the terminal's background, and one
 * status line names the holder and the grid, as tmux marks a smaller client.
 * Engine-neutral DOM only; the pane decides when it is held.
 */
export class TerminalHeldGeometryMark {
  private notice?: HTMLDivElement

  /** Idempotent: one notice node, updated in place; appending it again only keeps it last. */
  present(surface: HTMLElement, held: TerminalSize, background: string): void {
    surface.style.background = background
    const notice = this.notice ?? document.createElement('div')
    notice.className = 'terminal-held-geometry-notice'
    notice.setAttribute('role', 'status')
    notice.textContent = `Companion holds the size · ${held.cols}×${held.rows}`
    surface.append(notice)
    this.notice = notice
  }

  clear(surface: HTMLElement): void {
    surface.style.background = ''
    this.notice?.remove()
    this.notice = undefined
  }
}
