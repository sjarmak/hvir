import { describe, expect, it } from 'vitest'

import { externalSessionAttachment } from '../src/main/terminal/external-session-attachment'
import {
  isExternalSessionAttachment,
  isExternalSessionAttachTarget,
  sameExternalSessionAttachment,
} from '../src/shared'

describe('External session attach targets', () => {
  it('accepts a session id, an alias, or both, and rejects neither', () => {
    expect(isExternalSessionAttachTarget({ sourceId: 'gas-city', key: 'gc-1' })).toBe(
      true,
    )
    expect(isExternalSessionAttachTarget({ sourceId: 'gas-city', alias: 'mayor' })).toBe(
      true,
    )
    expect(
      isExternalSessionAttachTarget({
        sourceId: 'gas-city',
        key: 'gc-1',
        alias: 'mayor',
      }),
    ).toBe(true)
    expect(isExternalSessionAttachTarget({ sourceId: 'gas-city' })).toBe(false)
    expect(isExternalSessionAttachTarget({ sourceId: 'gas-city', alias: '' })).toBe(false)
    expect(isExternalSessionAttachTarget({ sourceId: 'gas-city', alias: 'a\nb' })).toBe(
      false,
    )
  })

  it('stores only digests and round-trips through the persistence validator', () => {
    const attachment = externalSessionAttachment({ sourceId: 'gas-city', alias: 'mayor' })

    expect(attachment.sessionDigest).toBeUndefined()
    expect(JSON.stringify(attachment)).not.toContain('mayor')
    expect(isExternalSessionAttachment(attachment)).toBe(true)
    expect(isExternalSessionAttachment({ sourceId: 'gas-city' })).toBe(false)
  })

  it('matches attachments that share either the session id or the alias', () => {
    const byAlias = externalSessionAttachment({ sourceId: 'gas-city', alias: 'mayor' })
    const byBoth = externalSessionAttachment({
      sourceId: 'gas-city',
      key: 'gc-1',
      alias: 'mayor',
    })
    const other = externalSessionAttachment({
      sourceId: 'gas-city',
      key: 'gc-2',
      alias: 'pl',
    })

    expect(sameExternalSessionAttachment(byAlias, byBoth)).toBe(true)
    expect(sameExternalSessionAttachment(byBoth, other)).toBe(false)
  })
})
