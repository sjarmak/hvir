import { describe, expect, it } from 'vitest'

import { createCompanionAssetReader } from '../src/main/companion/companion-assets'
import type { HostPath } from '../src/shared'

function reader() {
  const reads: string[] = []
  const host = {
    readFile: (path: HostPath) => {
      reads.push(path.path)
      return Promise.resolve(Buffer.from(path.path))
    },
  }
  return { reads, assets: createCompanionAssetReader(host, '/renderer') }
}

describe('Companion asset allowlist', () => {
  it('serves a Rollup shared chunk whose name leads with an underscore', async () => {
    const { reads, assets } = reader()
    const asset = await assets.read('assets/_commonjsHelpers-DWwsNxpa.js')
    expect(asset?.contentType).toBe('text/javascript; charset=utf-8')
    expect(reads).toEqual(['/renderer/assets/_commonjsHelpers-DWwsNxpa.js'])
  })

  it.each([
    'assets/../companion/index.html',
    'assets/sub/file.js',
    'assets/.hidden.js',
    'assets/-flag.js',
    'assets/script.exe',
    'renderer/index.html',
  ])('refuses %s before the host is asked', async (path) => {
    const { reads, assets } = reader()
    expect(await assets.read(path)).toBeUndefined()
    expect(reads).toEqual([])
  })
})
