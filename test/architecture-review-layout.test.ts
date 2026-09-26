import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

function rule(styles: string, selector: string): string {
  const match = styles.match(new RegExp(`\\${selector} \\{([^}]*)\\}`, 'u'))
  expect(match).not.toBeNull()
  return match![1]!
}

describe('architecture review layout', () => {
  it('keeps the inline map usable while making the full review reachable', () => {
    const styles = readFileSync(
      join(process.cwd(), 'src/renderer/src/styles/architecture-review.css'),
      'utf8',
    )

    expect(rule(styles, '.architecture-review')).toContain('overflow: auto')
    expect(rule(styles, '.architecture-review-body')).toContain('min-height: 320px')
  })
})
