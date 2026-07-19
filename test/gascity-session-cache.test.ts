import { describe, expect, it, vi } from 'vitest'

import { GasCitySessionCache } from '../src/main/gascity/gascity-sessions'
import { asHostId, hostPath, type GasCitySession } from '../src/shared'

const HOST = asHostId('local')
const MEM = hostPath(HOST, '/home/dev/city/rigs/mem')
const AOA = hostPath(HOST, '/home/dev/city/rigs/aoa')
const CITY = hostPath(HOST, '/home/dev/city')
const OTHER_CITY = hostPath(HOST, '/srv/other-city')

function sessions(name: string): readonly GasCitySession[] {
  return [{ id: 'gc-1', name, state: 'active' }]
}

function cache(
  load: () => Promise<readonly GasCitySession[]>,
  now: () => number = () => 0,
): GasCitySessionCache {
  return new GasCitySessionCache({ load, ttlMs: 3000, now })
}

describe('GasCitySessionCache', () => {
  it('serves a second workspace on the host without re-reading', async () => {
    const load = vi.fn(() => Promise.resolve(sessions('mem-pl')))
    const shared = cache(load)

    await shared.get(MEM, undefined)
    await shared.get(AOA, undefined)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('re-reads once the entry ages out, since this is the live half', async () => {
    let clock = 0
    const load = vi.fn(() => Promise.resolve(sessions('mem-pl')))
    const shared = cache(load, () => clock)

    await shared.get(MEM, undefined)
    clock = 2999
    await shared.get(MEM, undefined)
    expect(load).toHaveBeenCalledTimes(1)
    clock = 3001
    await shared.get(MEM, undefined)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight read between concurrent callers', () => {
    const load = vi.fn(() => Promise.resolve(sessions('mem-pl')))
    const shared = cache(load)

    expect(shared.get(MEM, undefined)).toBe(shared.get(AOA, undefined))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not serve a read attributed to a different city', async () => {
    const load = vi.fn(() => Promise.resolve(sessions('mem-pl')))
    const shared = cache(load)

    await shared.get(MEM, CITY)
    await shared.get(MEM, OTHER_CITY)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('drops a read once it is attributed to two different cities', async () => {
    const load = vi.fn(() => Promise.resolve(sessions('mem-pl')))
    const shared = cache(load)

    // The city is unknown at read time, so the second workspace shares it and
    // then discovers it belongs to another city.
    await shared.get(MEM, undefined)
    shared.attribute(HOST, CITY)
    await shared.get(AOA, undefined)
    expect(load).toHaveBeenCalledTimes(1)
    shared.attribute(HOST, OTHER_CITY)
    await shared.get(AOA, undefined)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps serving a read attributed to the city that asked for it', async () => {
    const load = vi.fn(() => Promise.resolve(sessions('mem-pl')))
    const shared = cache(load)

    await shared.get(MEM, undefined)
    shared.attribute(HOST, CITY)
    await shared.get(AOA, CITY)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('ignores attribution for a host it holds nothing for', () => {
    const shared = cache(() => Promise.resolve(sessions('mem-pl')))
    expect(() => shared.attribute(HOST, CITY)).not.toThrow()
  })

  it('does not cache a failure', async () => {
    const load = vi
      .fn<() => Promise<readonly GasCitySession[]>>()
      .mockRejectedValueOnce(new Error('gc exploded'))
      .mockResolvedValue(sessions('mem-pl'))
    const shared = cache(load)

    await expect(shared.get(MEM, undefined)).rejects.toThrow('gc exploded')
    await expect(shared.get(MEM, undefined)).resolves.toHaveLength(1)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('re-reads everything after an explicit refresh', async () => {
    const load = vi.fn(() => Promise.resolve(sessions('mem-pl')))
    const shared = cache(load)

    await shared.get(MEM, undefined)
    shared.invalidate()
    await shared.get(MEM, undefined)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
