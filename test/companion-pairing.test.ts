import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  CompanionPairing,
  PAIRING_CODE_TTL_MS,
  type CompanionCredentialRecord,
  type CompanionPairingEvent,
} from '../src/main/companion/companion-pairing'

const CODE_SHAPE = /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/
const START = 1_700_000_000_000

function harness() {
  let now = START
  let record: CompanionCredentialRecord | undefined
  const onRevoked = vi.fn()
  const events: CompanionPairingEvent[] = []
  const pairing = new CompanionPairing({
    credential: {
      current: () => record,
      store: (next) => {
        record = next
      },
      clear: () => {
        record = undefined
      },
    },
    now: () => now,
    onRevoked,
    onChange: (event) => events.push(event),
  })
  return {
    pairing,
    events,
    onRevoked,
    record: () => record,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('CompanionPairing', () => {
  it('issues a grouped base32 code that lives ten minutes', () => {
    const world = harness()
    const issued = world.pairing.issue()
    expect(issued.code).toMatch(CODE_SHAPE)
    expect(issued.expiresAt).toBe(START + PAIRING_CODE_TTL_MS)
    expect(PAIRING_CODE_TTL_MS).toBe(10 * 60_000)
    expect(world.pairing.outstandingCode()).toEqual(issued)
    expect(world.pairing.paired()).toBe(false)
    expect(world.events).toEqual(['issued'])
  })

  it('exchanges the code for a token exactly once and stores only its hash', () => {
    const world = harness()
    const { code } = world.pairing.issue()
    expect(world.pairing.exchange('WRONG-CODE')).toBeUndefined()
    expect(world.pairing.paired()).toBe(false)

    const token = world.pairing.exchange(code)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(world.pairing.exchange(code)).toBeUndefined()
    expect(world.pairing.outstandingCode()).toBeUndefined()
    expect(world.pairing.paired()).toBe(true)
    expect(world.record()).toEqual({
      hash: createHash('sha256').update(token!).digest('hex'),
      issuedAt: START,
    })
    expect(world.events).toEqual(['issued', 'paired'])
  })

  it('verifies only the minted token', () => {
    const world = harness()
    const token = world.pairing.exchange(world.pairing.issue().code)!
    expect(world.pairing.verify(token)).toBe(true)
    expect(world.pairing.verify(`${token.slice(0, -1)}x`)).toBe(false)
    expect(world.pairing.verify('')).toBe(false)
  })

  it('accepts the code as a person types it: lower case, no dashes, stray spaces', () => {
    const world = harness()
    const { code } = world.pairing.issue()
    const typed = ` ${code.toLowerCase().replaceAll('-', ' ')} `
    expect(world.pairing.exchange(typed)).toEqual(expect.any(String))
  })

  it('refuses an expired code', () => {
    const world = harness()
    const { code } = world.pairing.issue()
    world.advance(PAIRING_CODE_TTL_MS + 1)
    expect(world.pairing.outstandingCode()).toBeUndefined()
    expect(world.pairing.exchange(code)).toBeUndefined()
    expect(world.pairing.paired()).toBe(false)
  })

  it('replaces the outstanding code when issued again', () => {
    const world = harness()
    const first = world.pairing.issue()
    const second = world.pairing.issue()
    expect(second.code).not.toBe(first.code)
    expect(world.pairing.exchange(first.code)).toBeUndefined()
    expect(world.pairing.exchange(second.code)).toEqual(expect.any(String))
  })

  it('verifies nothing before pairing and forgets everything on revoke', () => {
    const world = harness()
    expect(world.pairing.verify('anything')).toBe(false)
    const token = world.pairing.exchange(world.pairing.issue().code)!
    world.pairing.issue()

    world.pairing.revoke()
    expect(world.pairing.verify(token)).toBe(false)
    expect(world.pairing.paired()).toBe(false)
    expect(world.pairing.outstandingCode()).toBeUndefined()
    expect(world.record()).toBeUndefined()
    expect(world.onRevoked).toHaveBeenCalledTimes(1)
    expect(world.events).toEqual(['issued', 'paired', 'issued', 'revoked'])
  })

  it('recognises a credential already on disk', () => {
    const token = 'previously-minted-token'
    const restored = new CompanionPairing({
      credential: {
        current: () => ({
          hash: createHash('sha256').update(token).digest('hex'),
          issuedAt: START,
        }),
        store: () => undefined,
        clear: () => undefined,
      },
    })
    expect(restored.paired()).toBe(true)
    expect(restored.verify(token)).toBe(true)
    expect(restored.verify('other')).toBe(false)
  })
})
