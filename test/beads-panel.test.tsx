import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BeadsPanel } from '../src/renderer/src/beads/BeadsPanel'
import { asHostId, hostPath } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/projects/demo')

describe('BeadsPanel', () => {
  it('renders the panel shell without a data round-trip', () => {
    // `renderToStaticMarkup` never runs effects, so the panel paints its empty
    // shell — a fast guard that the component and its imports stay wired without
    // needing a jsdom/window.hvir stub.
    const markup = renderToStaticMarkup(
      createElement(BeadsPanel, { root: ROOT, connected: false }),
    )
    expect(markup).toContain('Gas City')
    expect(markup).toContain('No data yet.')
  })
})
