import { describe, expect, it, vi } from 'vitest'

import {
  EXTERNAL_LINK_LIMITS,
  ExtensionExternalLinks,
  extensionExternalUrl,
} from '../src/main/extensions/external-link'
import { attached, fixture } from './fixtures/extension-guest'

describe('extension external links', () => {
  it('accepts only plain https github.com addresses', () => {
    expect(extensionExternalUrl({ url: 'https://github.com/acme/widgets/pull/7' })).toBe(
      'https://github.com/acme/widgets/pull/7',
    )
    for (const url of [
      'http://github.com/acme/widgets',
      'https://github.com.evil.test/acme',
      'https://gist.github.com/acme',
      'https://user:secret@github.com/acme',
      'https://github.com:8443/acme',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not a url',
      `https://github.com/${'a'.repeat(EXTERNAL_LINK_LIMITS.urlChars)}`,
    ])
      expect(() => extensionExternalUrl({ url })).toThrow()
    expect(() => extensionExternalUrl({})).toThrow()
    expect(() => extensionExternalUrl('https://github.com')).toThrow()
  })

  it('opens at most once per interval per installation and never opens a refused url', async () => {
    let now = 10_000
    const open = vi.fn(() => Promise.resolve())
    const links = new ExtensionExternalLinks(open, () => now)
    await links.open('one', { url: 'https://github.com/a' })
    await expect(links.open('one', { url: 'https://github.com/b' })).rejects.toThrow(
      'at most once per second',
    )
    await links.open('two', { url: 'https://github.com/c' })
    await expect(links.open('two', { url: 'https://example.com' })).rejects.toThrow()
    now += EXTERNAL_LINK_LIMITS.intervalMs
    await links.open('one', { url: 'https://github.com/d' })
    expect(open.mock.calls).toEqual([
      ['https://github.com/a'],
      ['https://github.com/c'],
      ['https://github.com/d'],
    ])
  })

  it('routes a visible guest request to the host and withholds the capability from updaters', async () => {
    const open = vi.fn(() => Promise.resolve())
    const data = fixture(
      {},
      { requiredCapabilities: ['viewer.open-external'] },
      undefined,
      {
        externalLinks: { open },
      },
    )
    await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'link',
      capability: 'viewer.open-external',
      input: { url: 'https://github.com/acme/widgets/pull/7' },
    })
    await vi.waitFor(() =>
      expect(data.sent.at(-1)?.message).toMatchObject({
        id: 'link',
        ok: true,
        value: null,
      }),
    )
    expect(open).toHaveBeenCalledWith('installation', {
      url: 'https://github.com/acme/widgets/pull/7',
    })
    await data.owner.dispose()

    const updater = fixture(
      {},
      {
        updater: 'index.html',
        requiredCapabilities: ['presentation.read'],
        optionalCapabilities: ['viewer.open-external'],
      },
    )
    const view = await updater.owner.open(
      updater.renderer,
      'installation',
      'updater',
      undefined,
      {
        updater: true,
      },
    )
    updater.owner.claim(updater.renderer, view.partition, view.url, view.id)
    updater.owner.bind(updater.renderer, view.partition, 10)
    updater.owner.receive(10, { kind: 'hello', contract: '1.0' })
    expect(
      updater.sent.find((entry) => entry.message.kind === 'hello')?.message,
    ).toMatchObject({ capabilities: ['presentation.read'] })
    await updater.owner.dispose()
  })
})
