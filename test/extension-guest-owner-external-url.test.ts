import { describe, expect, it, vi } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as generators from '@hegeldev/hegel/generators'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'
import {
  ExtensionSafeExternalUrl,
  safeExternalOrigin,
} from '../src/main/extensions/safe-external-url'
import type { ExtensionGuestPorts } from '../src/main/extensions/guest-capability-ports'
import { attached, fixture } from './fixtures/extension-guest'

describe('extension guest safe external URL', () => {
  it('accepts only browser-safe HTTPS URLs and returns their trusted origin', () =>
    hegel.test((testCase) => {
      const value = testCase.draw(generators.text())
      const origin = safeExternalOrigin(value)
      if (origin !== undefined) {
        const parsed = new URL(value)
        expect(parsed.protocol).toBe('https:')
        expect(origin).toBe(parsed.origin)
      }
    }))

  it('rejects every HTTPS URL containing forbidden authority or directional text', () =>
    hegel.test((testCase) => {
      const prefix = testCase.draw(generators.text({ maxSize: 32 }))
      const bidi = testCase.draw(
        generators.oneOf(
          generators.just('\u061c'),
          generators.just('\u200e'),
          generators.just('\u202e'),
          generators.just('\u2066'),
        ),
      )
      expect(
        safeExternalOrigin(`https://user:secret@example.test/${prefix}`),
      ).toBeUndefined()
      expect(safeExternalOrigin(`https://example.test/${prefix}${bidi}`)).toBeUndefined()
    }))

  it.each([
    ['https://example.test/path', 'https://example.test'],
    ['https://user:secret@example.test/path', undefined],
    ['https://example.test/path\u202e.txt', undefined],
    ['http://example.test', undefined],
    ['mailto:hello@example.test', undefined],
    ['javascript:alert(1)', undefined],
    ['not a URL', undefined],
  ])('derives a safe external origin from %s', (url, origin) => {
    expect(safeExternalOrigin(url)).toBe(origin)
  })

  it('confirms and launches the same canonical HTTPS URL', async () => {
    const confirm = vi.fn(() => Promise.resolve(true))
    const launch = vi.fn(() => Promise.resolve())
    const opener = new ExtensionSafeExternalUrl(confirm, launch)
    const current = vi.fn()
    await expect(
      opener.open(
        { owner: { id: 1, generation: 1 } },
        { url: '  https://example.test/a path?value=1  ' },
        current,
        new AbortController().signal,
      ),
    ).resolves.toBeNull()
    expect(confirm).toHaveBeenCalledWith(
      {
        url: 'https://example.test/a%20path?value=1',
        origin: 'https://example.test',
      },
      expect.any(AbortSignal),
      { id: 1, generation: 1 },
    )
    expect(current).toHaveBeenCalledTimes(2)
    expect(launch).toHaveBeenCalledWith('https://example.test/a%20path?value=1')
  })

  it('rejects non-HTTPS input before confirmation or browser launch', async () => {
    const confirm = vi.fn(() => Promise.resolve(true))
    const launch = vi.fn(() => Promise.resolve())
    const opener = new ExtensionSafeExternalUrl(confirm, launch)
    await expect(
      opener.open(
        { owner: { id: 1, generation: 1 } },
        { url: 'http://example.test/path' },
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow('External URLs must use HTTPS')
    expect(confirm).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('opens one confirmed HTTPS URL only from a visible human guest with native activation', async () => {
    const open = vi.fn<ExtensionGuestPorts['externalUrls']['open']>(() =>
      Promise.resolve(null),
    )
    const consumeUserActivation = vi
      .fn<(guestId: number) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const data = fixture(
      { consumeUserActivation },
      { requiredCapabilities: ['external.open'] },
      undefined,
      { externalUrls: { open } },
    )
    await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    expect(data.sent.find((entry) => entry.message.kind === 'hello')?.message).toMatchObject(
      { capabilities: ['external.open'] },
    )
    data.owner.receive(10, {
      kind: 'request',
      id: 'without-activation',
      capability: 'external.open',
      input: { url: 'https://example.test/first' },
      userActivated: true,
    })
    expect(data.sent.at(-1)?.message).toMatchObject({
      id: 'without-activation',
      ok: false,
      error: 'Activate the visible extension view before opening an external URL',
      warnings: ['Ignored unknown field: userActivated'],
    })
    expect(open).not.toHaveBeenCalled()
    data.owner.receive(10, {
      kind: 'request',
      id: 'activated',
      capability: 'external.open',
      input: { url: 'https://example.test/second' },
    })
    await vi.waitFor(() =>
      expect(data.sent.at(-1)?.message).toMatchObject({ id: 'activated', ok: true }),
    )
    expect(consumeUserActivation).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledOnce()
    expect(open.mock.calls[0]?.[1]).toEqual({ url: 'https://example.test/second' })
    await data.owner.dispose()
  })

  it('does not grant external URL opening to a non-human guest origin', async () => {
    const open = vi.fn<ExtensionGuestPorts['externalUrls']['open']>(() =>
      Promise.resolve(null),
    )
    const data = fixture(
      { consumeUserActivation: () => true },
      { requiredCapabilities: ['external.open'] },
      undefined,
      { externalUrls: { open } },
    )
    await attached(data, 10, 'agent')
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'agent-origin',
      capability: 'external.open',
      input: { url: 'https://example.test/path' },
    })
    expect(data.sent.at(-1)?.message).toMatchObject({
      id: 'agent-origin',
      ok: false,
      error: 'Activate the visible extension view before opening an external URL',
    })
    expect(open).not.toHaveBeenCalled()
    await data.owner.dispose()
  })

  it('does not grant external URL opening to an updater guest', async () => {
    const open = vi.fn<ExtensionGuestPorts['externalUrls']['open']>(() =>
      Promise.resolve(null),
    )
    const consumeUserActivation = vi.fn(() => true)
    const data = fixture(
      { consumeUserActivation },
      { requiredCapabilities: ['external.open'], updater: 'index.html' },
      undefined,
      { externalUrls: { open } },
    )
    const view = await data.owner.open(
      data.renderer,
      'installation',
      'updater',
      () => undefined,
      { updater: true },
    )
    data.owner.claim(data.renderer, view.partition, view.url, view.id)
    data.owner.bind(data.renderer, view.partition, 10)
    data.owner.presentation(
      data.renderer,
      view.id,
      DEFAULT_EXTENSION_PRESENTATION,
      true,
      true,
    )
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'updater-origin',
      capability: 'external.open',
      input: { url: 'https://example.test/path' },
    })
    expect(data.sent.at(-1)?.message).toMatchObject({
      id: 'updater-origin',
      ok: false,
      error:
        'Extension contract 1.0: capability external.open is unavailable or undeclared',
    })
    expect(consumeUserActivation).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    await data.owner.dispose()
  })
})
