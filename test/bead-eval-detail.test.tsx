import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseBeadsListOutput } from '../src/main/beads/beads-parse'
import { beadDetail } from '../src/renderer/src/beads/bead-card'
import type { BeadCard } from '../src/renderer/src/beads/beads-model'

function detail(metadata: Record<string, string>): string {
  const issue = parseBeadsListOutput(
    JSON.stringify([
      {
        id: 'test-eval',
        title: 'Evaluate candidate',
        status: 'open',
        metadata,
      },
    ]),
  )[0]!
  const card: BeadCard = { issue, blockedBy: [], unlocks: [], unlocksCount: 0 }
  return renderToStaticMarkup(beadDetail(card))
}

describe('evaluation facts in expanded Bead details', () => {
  it('shows a producer-supplied exact destination, provenance and unknown freshness', () => {
    const markup = detail({
      'eval.run_url': 'https://results.example/run/123',
      'eval.run_id': '123',
      'eval.model': '<script>alert(1)</script>',
    })
    expect(markup).toContain('href="https://results.example/run/123"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).toContain('Producer-supplied')
    expect(markup).toContain('Current result not verified')
    expect(markup).toContain('https://results.example')
    expect(markup).toContain('&lt;script&gt;')
    expect(markup).not.toContain('<script>')
  })

  it('discloses invalid metadata without making unsafe content clickable', () => {
    const markup = detail({ 'eval.run_url': 'javascript:alert(1)' })
    expect(markup).toContain('Evaluation link unavailable')
    expect(markup).not.toContain('href=')
    expect(markup).not.toContain('javascript:')
  })

  it('does not add a result section to existing beads without metadata', () => {
    expect(detail({})).not.toContain('Evaluation')
  })
})
