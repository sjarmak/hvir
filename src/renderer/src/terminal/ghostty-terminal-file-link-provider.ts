import type { ILink, ILinkProvider, Terminal as GhosttyTerminal } from 'ghostty-web'

import type { TerminalLinkActivation } from './terminal-pane'
import {
  detectTerminalFileLinks,
  detectTerminalWebLinks,
  isFileUri,
  isTerminalWebTarget,
} from './terminal-file-link'

export class FileLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: GhosttyTerminal,
    private readonly activateTarget: (activation: TerminalLinkActivation) => void,
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(y)
    if (!line) {
      callback(undefined)
      return
    }

    const text: string[] = []
    const links: ILink[] = []
    const visitedHyperlinkColumns = new Set<number>()
    const wasmTerm = this.terminal.wasmTerm
    const scrollbackLength = wasmTerm?.getScrollbackLength() ?? 0
    const viewportRow = y - scrollbackLength
    const hyperlinkTargetAt = (column: number): string | null => {
      if (!wasmTerm) return null
      return viewportRow < 0
        ? wasmTerm.getScrollbackHyperlinkUri(y, column)
        : wasmTerm.getHyperlinkUri(viewportRow, column)
    }
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x)
      const codepoint = cell?.getCodepoint() ?? 0
      text.push(codepoint < 32 ? ' ' : String.fromCodePoint(codepoint))
      const id = cell?.getHyperlinkId() ?? 0
      if (id <= 0 || visitedHyperlinkColumns.has(x)) continue
      const target = hyperlinkTargetAt(x)
      if (!target || (!isFileUri(target) && !isTerminalWebTarget(target))) continue
      let start = x
      let end = x
      while (
        start > 0 &&
        (line.getCell(start - 1)?.getHyperlinkId() ?? 0) > 0 &&
        hyperlinkTargetAt(start - 1) === target
      ) {
        start -= 1
      }
      while (
        end + 1 < line.length &&
        (line.getCell(end + 1)?.getHyperlinkId() ?? 0) > 0 &&
        hyperlinkTargetAt(end + 1) === target
      ) {
        end += 1
      }
      for (let column = start; column <= end; column += 1) {
        visitedHyperlinkColumns.add(column)
      }
      links.push(
        this.link(
          { kind: isFileUri(target) ? 'file' : 'loopback-http', target },
          y,
          start,
          end,
        ),
      )
    }

    const lineText = text.join('')
    for (const candidate of detectTerminalFileLinks(lineText)) {
      links.push(
        this.link(
          { kind: 'file', target: candidate.target },
          y,
          candidate.start,
          candidate.end,
        ),
      )
    }
    for (const candidate of detectTerminalWebLinks(lineText)) {
      links.push(
        this.link(
          { kind: 'loopback-http', target: candidate.target },
          y,
          candidate.start,
          candidate.end,
        ),
      )
    }
    callback(links.length > 0 ? links : undefined)
  }

  private link(
    activation: TerminalLinkActivation,
    y: number,
    start: number,
    end: number,
  ): ILink {
    return {
      text: activation.target,
      range: { start: { x: start, y }, end: { x: end, y } },
      activate: (event) => {
        if (event.ctrlKey || event.metaKey) this.activateTarget(activation)
      },
    }
  }
}
