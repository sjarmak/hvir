import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { developmentApplicationIcon } from '../src/main/window/application-icon'

describe('development application icon', () => {
  it('uses the platform-native development raster when Vite serves the renderer', () => {
    expect(
      developmentApplicationIcon('/workspace/hvir', 'linux', 'http://localhost:5173'),
    ).toBe(join('/workspace/hvir', 'build/icons-linux/512x512.png'))
    expect(
      developmentApplicationIcon('/workspace/hvir', 'darwin', 'http://localhost:5173'),
    ).toBe(join('/workspace/hvir', 'build/icon-macos.png'))
  })

  it('leaves packaged window icon ownership with electron-builder', () => {
    expect(
      developmentApplicationIcon('/workspace/hvir', 'linux', undefined),
    ).toBeUndefined()
  })
})
