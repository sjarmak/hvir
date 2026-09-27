import { expect, it } from 'vitest'
import { ByteBoundedCache } from '../src/main/architecture-review/byte-bounded-cache'

it('returns what was stored under the same key and charges its bytes', () => {
  const cache = new ByteBoundedCache<string>(100)
  cache.store('a', 'alpha', 5)
  cache.store('b', 'beta', 4)
  expect(cache.lookup('a')).toBe('alpha')
  expect(cache.lookup('b')).toBe('beta')
  expect(cache.lookup('c')).toBeUndefined()
  expect(cache.size).toBe(2)
  expect(cache.bytes).toBe(9)
})

it('evicts the least recently used entries until the bound holds', () => {
  const cache = new ByteBoundedCache<string>(10)
  cache.store('a', 'a', 4)
  cache.store('b', 'b', 4)
  expect(cache.lookup('a')).toBe('a')
  cache.store('c', 'c', 4)
  expect(cache.lookup('b')).toBeUndefined()
  expect(cache.lookup('a')).toBe('a')
  expect(cache.lookup('c')).toBe('c')
  expect(cache.bytes).toBe(8)
  cache.store('d', 'd', 10)
  expect(cache.size).toBe(1)
  expect(cache.lookup('d')).toBe('d')
})

it('replaces an entry stored again under its key without double charging', () => {
  const cache = new ByteBoundedCache<string>(10)
  cache.store('a', 'short', 3)
  cache.store('a', 'longer', 6)
  expect(cache.lookup('a')).toBe('longer')
  expect(cache.size).toBe(1)
  expect(cache.bytes).toBe(6)
})

it('never stores an entry larger than the whole bound and drops its stale predecessor', () => {
  const cache = new ByteBoundedCache<string>(10)
  cache.store('a', 'fits', 4)
  cache.store('b', 'fits', 4)
  cache.store('a', 'too big', 11)
  expect(cache.lookup('a')).toBeUndefined()
  expect(cache.lookup('b')).toBe('fits')
  expect(cache.bytes).toBe(4)
})

it('refuses a non-positive bound and a malformed byte count', () => {
  expect(() => new ByteBoundedCache<string>(0)).toThrow(/positive/)
  expect(() => new ByteBoundedCache<string>(1.5)).toThrow(/positive/)
  const cache = new ByteBoundedCache<string>(10)
  expect(() => cache.store('a', 'a', -1)).toThrow(/byte/)
  expect(() => cache.store('a', 'a', 0.5)).toThrow(/byte/)
})

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface ModelEntry {
  readonly key: string
  readonly value: number
  readonly bytes: number
}

function modelLookup(model: ModelEntry[], key: string): number | undefined {
  const index = model.findIndex((entry) => entry.key === key)
  if (index < 0) return undefined
  const [entry] = model.splice(index, 1)
  model.push(entry!)
  return entry!.value
}

function modelStore(model: ModelEntry[], bound: number, entry: ModelEntry): void {
  const index = model.findIndex((candidate) => candidate.key === entry.key)
  if (index >= 0) model.splice(index, 1)
  if (entry.bytes > bound) return
  model.push(entry)
  let total = model.reduce((sum, candidate) => sum + candidate.bytes, 0)
  while (total > bound) total -= model.shift()!.bytes
}

it('agrees with a recency-ordered model over random lookups and stores', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = seededRandom(seed)
    const bound = 1 + Math.floor(random() * 64)
    const cache = new ByteBoundedCache<number>(bound)
    const model: ModelEntry[] = []
    for (let step = 0; step < 200; step += 1) {
      const key = String.fromCharCode(97 + Math.floor(random() * 8))
      if (random() < 0.4) {
        expect(cache.lookup(key)).toBe(modelLookup(model, key))
      } else {
        const entry = { key, value: step, bytes: Math.floor(random() * (bound + 4)) }
        cache.store(entry.key, entry.value, entry.bytes)
        modelStore(model, bound, entry)
      }
      expect(cache.size).toBe(model.length)
      expect(cache.bytes).toBe(model.reduce((sum, entry) => sum + entry.bytes, 0))
      expect(cache.bytes).toBeLessThanOrEqual(bound)
    }
    for (const entry of model) expect(cache.lookup(entry.key)).toBe(entry.value)
  }
})
