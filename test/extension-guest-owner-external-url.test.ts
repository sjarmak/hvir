import { describe, expect, it, vi } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as generators from '@hegeldev/hegel/generators'
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

  it.each([
    ['https://example.test/path', 'https://example.test'],
    ['https://user:secret@example.test/path', 'https://example.test'],
    ['http://example.test', undefined],
    ['mailto:hello@example.test', undefined],
    ['javascript:alert(1)', undefined],
    ['not a URL', undefined],
  ])('derives a safe external origin from %s', (url, origin) => {
    expect(safeExternalOrigin(url)).toBe(origin)
  })

  it('confirms the parsed origin before launching the exact HTTPS URL', async () => {
    const confirm = vi.fn(() => Promise.resolve(true))
    const launch = vi.fn(() => Promise.resolve())
    const opener = new ExtensionSafeExternalUrl(confirm, launch)
    const current = vi.fn()
    await expect(
      opener.open(
        { owner: { id: 1, generation: 1 } },
        { url: 'https://example.test/path?value=1' },
        current,
        new AbortController().signal,
      ),
    ).resolves.toBeNull()
    expect(confirm).toHaveBeenCalledWith(
      {
        url: 'https://example.test/path?value=1',
        origin: 'https://example.test',
      },
      expect.any(AbortSignal),
      { id: 1, generation: 1 },
    )
    expect(current).toHaveBeenCalledTimes(2)
    expect(launch).toHaveBeenCalledWith('https://example.test/path?value=1')
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
})
