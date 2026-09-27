// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import {
  ARCHITECTURE_FILTER_STORAGE_KEY,
  commitShownUnderFilter,
  readArchitectureFilter,
  setArchitectureFilter,
} from '../src/renderer/src/architecture-review/architecture-history-filter'

beforeEach(() => {
  localStorage.clear()
  setArchitectureFilter(false)
})

it('remembers the filter across reads', () => {
  expect(readArchitectureFilter()).toBe(false)
  setArchitectureFilter(true)
  expect(readArchitectureFilter()).toBe(true)
  expect(localStorage.getItem(ARCHITECTURE_FILTER_STORAGE_KEY)).toBe('true')
})

it('shows every commit when the filter is off', () => {
  expect(commitShownUnderFilter(false, true, 'none')).toBe(true)
  expect(commitShownUnderFilter(false, false, undefined)).toBe(true)
})

it('hides merges, non-architecture commits and rows still classifying when the filter is on', () => {
  expect(commitShownUnderFilter(true, true, 'architecture')).toBe(false)
  expect(commitShownUnderFilter(true, false, 'architecture')).toBe(true)
  expect(commitShownUnderFilter(true, false, 'code')).toBe(false)
  expect(commitShownUnderFilter(true, false, 'none')).toBe(false)
  expect(commitShownUnderFilter(true, false, 'unclassified')).toBe(true)
  expect(commitShownUnderFilter(true, false, undefined)).toBe(false)
})
