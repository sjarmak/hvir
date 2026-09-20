// @vitest-environment happy-dom

/**
 * The phone page renders its mirror through a port shaped like the desktop's
 * engine-neutral `TerminalPane` seam (ADR-003, ADR-050). The page tree may not
 * import the desktop renderer, so the conformance is pinned here, outside the
 * page tree, and enforced by `npm run typecheck`: the companion pane is
 * assignable to the members of `TerminalPane` it mirrors.
 */
import { describe, expect, it } from 'vitest'

import type {
  CompanionTerminalPane,
  CompanionTerminalPaneFactory,
} from '../src/renderer/companion/src/companion-terminal-pane'
import type { TerminalPane } from '../src/renderer/src/terminal/terminal-pane'

/**
 * `scroll`, `isAlternateScreen`, `endGesture`, `returnToLive`, the navigation channel, and the
 * viewport subscription stay out of the mirrored subset on purpose: the desktop pane owns its gesture
 * inside its own engine adapter, and it has a scrollbar where the phone has a
 * control that returns to the live edge, so there is no counterpart to narrow
 * against (ADR-053). They are stubbed inert here rather than recorded, since
 * this test's subject is the narrowed subset and never the verbs beside it.
 */
type MirroredPane = Pick<TerminalPane, 'mount' | 'write' | 'resize' | 'dispose'>
type MirroredEvents = Pick<TerminalPane['events'], 'onData'>

function conforms(pane: CompanionTerminalPane): {
  readonly pane: MirroredPane
  readonly events: MirroredEvents
} {
  const mirrored: MirroredPane = pane
  const events: MirroredEvents = pane.events
  return { pane: mirrored, events }
}

describe('Companion terminal pane seam', () => {
  it('keeps the TerminalPane method names and data event shape', async () => {
    const calls: string[] = []
    const factory: CompanionTerminalPaneFactory = (cols, rows) =>
      Promise.resolve({
        mount: () => calls.push(`mount ${cols}x${rows}`),
        write: (data) => calls.push(`write ${data.length}`),
        resize: (nextCols, nextRows) => calls.push(`resize ${nextCols}x${nextRows}`),
        scroll: () => 0,
        isAlternateScreen: () => false,
        endGesture: () => undefined,
        returnToLive: () => undefined,
        dispose: () => calls.push('dispose'),
        setInputEnabled: (enabled) => calls.push(`input ${enabled}`),
        events: {
          onData: () => () => {
            calls.push('off')
          },
          onNavigation: () => () => undefined,
          onViewport: () => () => undefined,
        },
      })
    const { pane, events } = conforms(await factory(80, 24))
    pane.mount(document.createElement('div'))
    pane.write('ab')
    pane.resize(100, 30)
    void events.onData(() => undefined)()
    pane.dispose()
    expect(calls).toEqual(['mount 80x24', 'write 2', 'resize 100x30', 'off', 'dispose'])
  })
})
