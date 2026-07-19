import { describe, expect, it, vi } from 'vitest'

import {
  GasCityContextCache,
  isCityWorkspace,
  type GasCityContext,
} from '../src/main/gascity/gascity-context'
import { asHostId, hostPath } from '../src/shared'

const HOST = asHostId('local')
const ROOT = hostPath(HOST, '/home/dev/city/rigs/mem')
const CITY = hostPath(HOST, '/home/dev/city')

function context(rigName: string): GasCityContext {
  return { rigName, cityRoot: CITY, hqRigName: 'hq', config: { agents: [], namedSessions: [] } }
}

describe('GasCityContextCache', () => {
  it('reads the city once and serves the rest of the polls from cache', () => {
    let clock = 0
    const load = vi.fn(() => Promise.resolve(context('mem')))
    const cache = new GasCityContextCache({ load, ttlMs: 1000, now: () => clock })

    void cache.get(ROOT, true)
    clock = 900
    void cache.get(ROOT, true)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('re-reads once the entry has aged out, so a config edit lands', () => {
    let clock = 0
    const load = vi.fn(() => Promise.resolve(context('mem')))
    const cache = new GasCityContextCache({ load, ttlMs: 1000, now: () => clock })

    void cache.get(ROOT, true)
    clock = 1001
    void cache.get(ROOT, true)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight load between concurrent callers', () => {
    const load = vi.fn(() => Promise.resolve(context('mem')))
    const cache = new GasCityContextCache({ load, now: () => 0 })

    const first = cache.get(ROOT, true)
    const second = cache.get(ROOT, true)
    expect(first).toBe(second)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failure, so one bad gc call is not pinned for the whole TTL', async () => {
    const load = vi
      .fn<() => Promise<GasCityContext>>()
      .mockRejectedValueOnce(new Error('gc exploded'))
      .mockResolvedValue(context('mem'))
    const cache = new GasCityContextCache({ load, ttlMs: 10_000, now: () => 0 })

    await expect(cache.get(ROOT, true)).rejects.toThrow('gc exploded')
    await expect(cache.get(ROOT, true)).resolves.toMatchObject({ rigName: 'mem' })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('caches the config and no-config variants separately', () => {
    const load = vi.fn(() => Promise.resolve(context('mem')))
    const cache = new GasCityContextCache({ load, now: () => 0 })

    void cache.get(ROOT, true)
    void cache.get(ROOT, false)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('peeks a settled entry without starting a load', async () => {
    const load = vi.fn(() => Promise.resolve(context('mem')))
    const cache = new GasCityContextCache({ load, ttlMs: 10_000, now: () => 0 })

    expect(cache.peek(ROOT)).toBeUndefined()
    await cache.get(ROOT, true)
    expect(cache.peek(ROOT)).toMatchObject({ rigName: 'mem' })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('peeks nothing while the load is still in flight or has aged out', async () => {
    let clock = 0
    let settle!: (value: GasCityContext) => void
    const load = vi.fn(() => new Promise<GasCityContext>((resolve) => (settle = resolve)))
    const cache = new GasCityContextCache({ load, ttlMs: 1000, now: () => clock })

    const pending = cache.get(ROOT, true)
    expect(cache.peek(ROOT)).toBeUndefined()
    settle(context('mem'))
    await pending
    expect(cache.peek(ROOT)).toMatchObject({ rigName: 'mem' })

    clock = 1001
    expect(cache.peek(ROOT)).toBeUndefined()
  })

  it('re-reads after an explicit invalidate', () => {
    const load = vi.fn(() => Promise.resolve(context('mem')))
    const cache = new GasCityContextCache({ load, ttlMs: 10_000, now: () => 0 })

    void cache.get(ROOT, true)
    cache.invalidate(ROOT)
    void cache.get(ROOT, true)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('leaves other workspaces alone when one is invalidated', () => {
    const load = vi.fn(() => Promise.resolve(context('mem')))
    const cache = new GasCityContextCache({ load, ttlMs: 10_000, now: () => 0 })
    const other = hostPath(HOST, '/home/dev/city/rigs/aoa')

    void cache.get(ROOT, true)
    void cache.get(other, true)
    cache.invalidate(ROOT)
    void cache.get(other, true)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('isCityWorkspace', () => {
  it('is true only at the city root itself', () => {
    expect(isCityWorkspace(context('hq'), CITY)).toBe(true)
    expect(isCityWorkspace(context('mem'), ROOT)).toBe(false)
  })

  it('is false when no city root resolved', () => {
    expect(
      isCityWorkspace({ config: { agents: [], namedSessions: [] } }, CITY),
    ).toBe(false)
  })
})
