import { describe, expect, it } from 'vitest'

import {
  COMPANION_DEFAULT_PORT,
  isCompanionConfigSave,
  isCompanionPushUrl,
} from '../src/shared'

const save = (fields: Record<string, unknown>): Record<string, unknown> => ({
  enabled: false,
  port: COMPANION_DEFAULT_PORT,
  mirrorInputAllowed: false,
  ...fields,
})

describe('companion settings wire guard', () => {
  it('accepts the minimal save and a save with a push sink', () => {
    expect(isCompanionConfigSave(save({}))).toBe(true)
    expect(
      isCompanionConfigSave(
        save({
          enabled: true,
          port: 1024,
          push: { url: 'https://ntfy.example/hvir', token: 'x'.repeat(512) },
        }),
      ),
    ).toBe(true)
    expect(
      isCompanionConfigSave(
        save({ enabled: true, port: 65535, push: { url: 'http://127.0.0.1:8080' } }),
      ),
    ).toBe(true)
    expect(
      isCompanionConfigSave(
        save({ enabled: true, port: 65535, push: { url: 'https://a.b', token: '' } }),
      ),
    ).toBe(true)
  })

  it('rejects a save without mirrorInputAllowed', () => {
    expect(isCompanionConfigSave(save({ mirrorInputAllowed: true }))).toBe(true)
    expect(isCompanionConfigSave({ enabled: false, port: COMPANION_DEFAULT_PORT })).toBe(
      false,
    )
    expect(isCompanionConfigSave(save({ mirrorInputAllowed: 'yes' }))).toBe(false)
    expect(isCompanionConfigSave(save({ mirrorInputAllowed: 1 }))).toBe(false)
  })

  it('rejects ports outside the unprivileged range or not integral', () => {
    for (const port of [0, 80, 1023, 65536, 47811.5, Number.NaN, '47811']) {
      expect(isCompanionConfigSave(save({ enabled: true, port })), String(port)).toBe(
        false,
      )
    }
  })

  it('rejects push sinks that would carry the token in the clear off the machine', () => {
    for (const url of [
      'http://ntfy.example/hvir',
      'http://localhost:8080',
      'http://127.0.0.1.evil.example',
      'ftp://x.example',
      'not a url',
      '',
    ]) {
      expect(isCompanionPushUrl(url), url).toBe(false)
      expect(
        isCompanionConfigSave(save({ enabled: true, port: 2000, push: { url } })),
        url,
      ).toBe(false)
    }
    expect(isCompanionPushUrl('https://ntfy.example/hvir')).toBe(true)
    expect(isCompanionPushUrl('http://127.0.0.1/hvir')).toBe(true)
  })

  it('rejects an oversized token, wrong shapes and unknown keys', () => {
    expect(
      isCompanionConfigSave(
        save({
          enabled: true,
          port: 2000,
          push: { url: 'https://a.b', token: 'x'.repeat(513) },
        }),
      ),
    ).toBe(false)
    expect(isCompanionConfigSave(save({ enabled: 'yes', port: 2000 }))).toBe(false)
    const { enabled: _enabled, ...withoutEnabled } = save({ port: 2000 })
    expect(isCompanionConfigSave(withoutEnabled)).toBe(false)
    expect(isCompanionConfigSave(save({ enabled: true, port: 2000, extra: 1 }))).toBe(
      false,
    )
    expect(
      isCompanionConfigSave(
        save({ enabled: true, port: 2000, push: { url: 'https://a.b', extra: 1 } }),
      ),
    ).toBe(false)
    expect(isCompanionConfigSave(null)).toBe(false)
    expect(isCompanionConfigSave([])).toBe(false)
  })
})
