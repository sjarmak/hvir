import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { loadArchitectureScanners } from '../src/main/architecture-review/architecture-scanners'
import { TREE_SITTER_ASSETS } from '../src/main/architecture-review/tree-sitter-assets'
import { loadInstalledScanners } from './architecture-scanner-fixtures'

const require = createRequire(import.meta.url)
const installed = (module: string) => readFileSync(require.resolve(module))

describe('architecture scanner set', () => {
  it('loads the TypeScript scanner and the Python, Go and Rust grammars from the packaged assets', async () => {
    const scanners = await loadInstalledScanners()
    expect(scanners.scanners.map((scanner) => scanner.language)).toEqual([
      'typescript',
      'python',
      'go',
      'rust',
    ])
    expect(scanners.scannerFor('src/a.tsx')).toMatchObject({ kind: '.tsx' })
    expect(scanners.scannerFor('src/a.d.ts')).toMatchObject({ kind: '.d.ts' })
    expect(scanners.scannerFor('pkg/a.py')).toMatchObject({ kind: '.py' })
    expect(scanners.scannerFor('pkg/a.go')).toMatchObject({ kind: '.go' })
    expect(scanners.scannerFor('src/lib.rs')).toMatchObject({ kind: '.rs' })
    expect(scanners.scannerFor('README.md')).toBeUndefined()
  })

  it('versions each grammar scanner by the exact runtime and grammar bytes', async () => {
    const scanners = await loadInstalledScanners()
    const digest = createHash('sha256')
      .update(installed(TREE_SITTER_ASSETS.runtime.module))
      .update(installed(TREE_SITTER_ASSETS.python.module))
      .digest('hex')
      .slice(0, 16)
    expect(scanners.scannerFor('a.py')!.scanner.version).toBe(
      `python-facts-1+wasm-${digest}`,
    )
    const go = createHash('sha256')
      .update(installed(TREE_SITTER_ASSETS.runtime.module))
      .update(installed(TREE_SITTER_ASSETS.go.module))
      .digest('hex')
      .slice(0, 16)
    expect(scanners.scannerFor('a.go')!.scanner.version).toBe(`go-facts-1+wasm-${go}`)
    const rust = createHash('sha256')
      .update(installed(TREE_SITTER_ASSETS.runtime.module))
      .update(installed(TREE_SITTER_ASSETS.rust.module))
      .digest('hex')
      .slice(0, 16)
    expect(scanners.scannerFor('a.rs')!.scanner.version).toBe(`rust-facts-5+wasm-${rust}`)
    expect(scanners.scannerFor('a.ts')!.scanner.version).toMatch(
      /^typescript-facts-1\+typescript-\d+\.\d+\.\d+/,
    )
  })

  it('names the asset it could not read', async () => {
    await expect(
      loadArchitectureScanners((asset) =>
        asset.file === TREE_SITTER_ASSETS.go.file
          ? Promise.reject(
              Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
            )
          : Promise.resolve(installed(asset.module)),
      ),
    ).rejects.toThrow(
      'Architecture scanner asset tree-sitter-go.wasm could not be read: ENOENT: no such file',
    )
  })

  it('refuses a grammar that is not a loadable WebAssembly module', async () => {
    await expect(
      loadArchitectureScanners((asset) =>
        Promise.resolve(
          asset.file === TREE_SITTER_ASSETS.python.file
            ? Buffer.from('not wasm')
            : installed(asset.module),
        ),
      ),
    ).rejects.toThrow(
      /^Architecture scanner grammar tree-sitter-python\.wasm failed to load: /,
    )
  })
})
