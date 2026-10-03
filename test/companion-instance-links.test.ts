import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'

import {
  COMPANION_INSTANCE_LINKS_KEY,
  addCompanionInstanceLink,
  canonicalCompanionEndpoint,
  decodeCompanionInstanceLinks,
  readCompanionInstanceLinks,
  removeCompanionInstanceLink,
  renameCompanionInstanceLink,
  type CompanionInstanceLink,
} from '../src/renderer/companion/src/companion-instance-links'

function memoryStorage(initial?: string): Storage {
  let value = initial
  return {
    getItem: () => value ?? null,
    setItem: (_key, next) => {
      value = next
    },
    removeItem: () => {
      value = undefined
    },
    clear: () => {
      value = undefined
    },
    key: () => null,
    get length() {
      return value === undefined ? 0 : 1
    },
  }
}

const LINK: CompanionInstanceLink = {
  id: 'one',
  name: 'Desk',
  url: 'https://desk.example/',
}

describe('companion instance links', () => {
  it('accepts HTTPS origins and normalizes the root path', () => {
    expect(canonicalCompanionEndpoint('https://desk.example')).toBe(
      'https://desk.example/',
    )
    expect(canonicalCompanionEndpoint('https://desk.example/')).toBe(
      'https://desk.example/',
    )
    expect(canonicalCompanionEndpoint('http://localhost:4312')).toBe(
      'http://localhost:4312/',
    )
  })

  it('rejects unsafe or non-root endpoints', () => {
    for (const value of [
      'javascript:alert(1)',
      'http://desk.example/',
      'http://192.168.1.4/',
      'https://user:pass@desk.example/',
      'https://desk.example/?token=secret',
      'https://desk.example/#secret',
      'https://desk.example/companion',
      'https://desk.example/path',
    ]) {
      expect(() => canonicalCompanionEndpoint(value)).toThrow()
    }
  })

  it('preserves corrupt storage as an explicit read failure', () => {
    expect(readCompanionInstanceLinks(memoryStorage('{'))).toEqual({
      status: 'error',
      message:
        'Saved Companion links are unreadable. Remove the corrupted entry to recover.',
    })
  })

  it('round-trips valid links and keeps storage origin-local', () => {
    const storage = memoryStorage()
    expect(addCompanionInstanceLink(storage, LINK)).toEqual({
      status: 'saved',
      links: [LINK],
    })
    expect(storage.getItem(COMPANION_INSTANCE_LINKS_KEY)).toContain('desk.example')
    expect(readCompanionInstanceLinks(storage)).toEqual({ status: 'ok', links: [LINK] })
  })

  it('renames and removes by opaque id', () => {
    expect(renameCompanionInstanceLink([LINK], 'one', 'New')).toEqual([
      { ...LINK, name: 'New' },
    ])
    expect(removeCompanionInstanceLink([LINK], 'one')).toEqual([])
  })

  it('keeps a bounded catalog', () => {
    const links = Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      name: `Desk ${index}`,
      url: `https://desk-${index}.example/`,
    }))
    const storage = memoryStorage(JSON.stringify(links))
    expect(
      addCompanionInstanceLink(
        storage,
        { id: 'new', name: 'New', url: 'https://new.example/' },
        links,
      ),
    ).toMatchObject({
      status: 'error',
    })
    expect(readCompanionInstanceLinks(storage)).toEqual({ status: 'ok', links })
  })

  it('keeps the existing catalog when a write fails', () => {
    const storage = {
      getItem: () => JSON.stringify([LINK]),
      setItem: () => {
        throw new Error('quota')
      },
    }
    const result = addCompanionInstanceLink(storage, {
      id: 'two',
      name: 'Lab',
      url: 'https://lab.example/',
    })
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.message).toContain('stored')
    expect(readCompanionInstanceLinks(storage)).toEqual({ status: 'ok', links: [LINK] })
  })

  it('decodes and re-encodes every generated valid catalog', () =>
    hegel.test(
      (tc) => {
        const values = tc.draw(
          gs.arrays(gs.integers({ minValue: 0, maxValue: 19 })),
        ) as readonly number[]
        const links = [...new Set(values)].map((value) => ({
          id: String(value),
          name: `Desk ${value}`,
          url: `https://desk-${value}.example/`,
        }))
        expect(decodeCompanionInstanceLinks(JSON.stringify(links))).toEqual(links)
      },
      { testCases: 100, seed: 17 },
    ))
})
