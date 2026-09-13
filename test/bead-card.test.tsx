import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { beadDetail } from '../src/renderer/src/beads/bead-card'
import { BEAD_ACTION_HINTS } from '../src/renderer/src/beads/bead-commands'
import type { BeadCard } from '../src/renderer/src/beads/beads-model'

function card(status: string): BeadCard {
  return {
    issue: {
      id: 'hv-12',
      title: 'T',
      status,
      priority: 2,
      issueType: 'task',
      labels: [],
      dependencyCount: 0,
      dependentCount: 0,
    },
    blockedBy: [],
    unlocks: [],
    unlocksCount: 0,
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

describe('beadDetail actions', () => {
  it('renders claim and close on an open bead when a callback is given', () => {
    const markup = renderToStaticMarkup(beadDetail(card('open'), () => undefined))
    expect(markup).toContain('class="beads-actions"')
    expect(markup).toContain('>Claim</button>')
    expect(markup).toContain('>Close</button>')
    expect(markup).toContain(`title="${escapeHtml(BEAD_ACTION_HINTS.claim)}"`)
    expect(markup).toContain(`title="${escapeHtml(BEAD_ACTION_HINTS.close)}"`)
  })

  it('renders only close on an in-progress bead', () => {
    const markup = renderToStaticMarkup(beadDetail(card('in_progress'), () => undefined))
    expect(markup).not.toContain('>Claim</button>')
    expect(markup).toContain('>Close</button>')
  })

  it('renders no actions on a closed bead', () => {
    const markup = renderToStaticMarkup(beadDetail(card('closed'), () => undefined))
    expect(markup).not.toContain('beads-actions')
  })

  it('stays read-only without a callback', () => {
    // BeadsRailPanel composed without a workspace passes no callback; the panel
    // must not paint write affordances it cannot deliver.
    const markup = renderToStaticMarkup(beadDetail(card('open')))
    expect(markup).not.toContain('beads-actions')
  })
})
