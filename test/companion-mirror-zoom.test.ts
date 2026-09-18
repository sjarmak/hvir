import { describe, expect, it } from 'vitest'

import {
  COMPANION_MIRROR_ZOOM_STORAGE_KEY,
  DEFAULT_MIRROR_ZOOM,
  isCompanionMirrorZoom,
  mirrorScale,
  mirrorZoomAction,
  nextMirrorZoom,
  readMirrorZoom,
  writeMirrorZoom,
} from '../src/renderer/companion/src/companion-mirror-zoom'

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const THROWING = (): Storage => {
  throw new Error('storage is off')
}

describe('Companion mirror zoom', () => {
  it('defaults to fill-height and toggles between the two modes', () => {
    expect(DEFAULT_MIRROR_ZOOM).toBe('fill-height')
    expect(nextMirrorZoom('fit-width')).toBe('fill-height')
    expect(nextMirrorZoom('fill-height')).toBe('fit-width')
    expect(mirrorZoomAction('fit-width')).toBe('Fill height')
    expect(mirrorZoomAction('fill-height')).toBe('Fit width')
  })

  it('accepts only the two mode names', () => {
    expect(isCompanionMirrorZoom('fit-width')).toBe(true)
    expect(isCompanionMirrorZoom('fill-height')).toBe(true)
    expect(isCompanionMirrorZoom('fill')).toBe(false)
    expect(isCompanionMirrorZoom(null)).toBe(false)
    expect(isCompanionMirrorZoom(7)).toBe(false)
  })

  it('fit-to-width scales down to the host width, never up, and never past the host height', () => {
    const grid = { gridWidth: 1000, gridHeight: 500 }
    expect(mirrorScale('fit-width', { hostWidth: 400, hostHeight: 900, ...grid })).toBe(0.4)
    expect(mirrorScale('fit-width', { hostWidth: 2000, hostHeight: 900, ...grid })).toBe(1)
    expect(mirrorScale('fit-width', { hostWidth: 400, hostHeight: 100, ...grid })).toBe(0.2)
  })

  it('fill-height scales the rows to the host height and lets the width overflow', () => {
    const grid = { gridWidth: 1000, gridHeight: 500 }
    expect(mirrorScale('fill-height', { hostWidth: 400, hostHeight: 750, ...grid })).toBe(1.5)
    expect(mirrorScale('fill-height', { hostWidth: 400, hostHeight: 250, ...grid })).toBe(0.5)
  })

  it('has no scale while the host or the grid has no layout', () => {
    const grid = { gridWidth: 1000, gridHeight: 500 }
    expect(mirrorScale('fit-width', { hostWidth: 0, hostHeight: 500, ...grid })).toBeUndefined()
    expect(mirrorScale('fill-height', { hostWidth: 400, hostHeight: 0, ...grid })).toBeUndefined()
    expect(
      mirrorScale('fill-height', { hostWidth: 400, hostHeight: 500, gridWidth: 0, gridHeight: 0 }),
    ).toBeUndefined()
  })

  it('reads a stored mode, falls back to the default for anything else, and writes the choice', () => {
    const storage = new MemoryStorage()
    const provider = (): Storage => storage as unknown as Storage
    expect(readMirrorZoom(provider)).toBe('fill-height')
    writeMirrorZoom(provider, 'fit-width')
    expect(storage.getItem(COMPANION_MIRROR_ZOOM_STORAGE_KEY)).toBe('fit-width')
    expect(readMirrorZoom(provider)).toBe('fit-width')
    storage.setItem(COMPANION_MIRROR_ZOOM_STORAGE_KEY, 'sideways')
    expect(readMirrorZoom(provider)).toBe('fill-height')
  })

  it('survives a storage that throws, reading the default and dropping the write', () => {
    expect(readMirrorZoom(THROWING)).toBe('fill-height')
    expect(() => writeMirrorZoom(THROWING, 'fit-width')).not.toThrow()
  })
})
