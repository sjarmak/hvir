import { expect, it } from 'vitest'
import { CommitChangeCache } from '../src/main/architecture-review/commit-change-cache'
import { localPath } from '../src/shared/host-path'

const root = localPath('/repo')
const key = (revision: string, scanners = 's1', layout = 'default') => ({
  root,
  revision,
  parent: `${revision}^`,
  scanners,
  layout,
})

it('returns what was stored for the same commit pair, scanners and layout only', () => {
  const cache = new CommitChangeCache(10)
  cache.store(key('c1'), 'architecture')
  expect(cache.lookup(key('c1'))).toBe('architecture')
  expect(cache.lookup(key('c2'))).toBeUndefined()
  expect(cache.lookup(key('c1', 's2'))).toBeUndefined()
  expect(cache.lookup(key('c1', 's1', 'override:abc'))).toBeUndefined()
  expect(cache.lookup({ ...key('c1'), parent: null })).toBeUndefined()
  expect(cache.lookup({ ...key('c1'), root: localPath('/other') })).toBeUndefined()
})

it('evicts the least recently used entry past its bound', () => {
  const cache = new CommitChangeCache(2)
  cache.store(key('c1'), 'code')
  cache.store(key('c2'), 'none')
  expect(cache.lookup(key('c1'))).toBe('code')
  cache.store(key('c3'), 'architecture')
  expect(cache.lookup(key('c2'))).toBeUndefined()
  expect(cache.lookup(key('c1'))).toBe('code')
  expect(cache.lookup(key('c3'))).toBe('architecture')
  expect(cache.size).toBe(2)
})

it('refuses a bound below one', () => {
  expect(() => new CommitChangeCache(0)).toThrow(/positive/)
})
