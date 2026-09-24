import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import type { ArchitectureSourceFile } from '../src/shared/architecture-analysis'
import { loadArchitectureScanners } from '../src/main/architecture-review/architecture-scanners'
import type { ScannerSet } from '../src/main/architecture-review/language-scanner'

const require = createRequire(import.meta.url)
const FIXTURE = join(__dirname, 'fixtures', 'architecture-python')

/** The real Python tree under test/fixtures, as repository-relative source files. */
export function pythonFixture(): readonly ArchitectureSourceFile[] {
  return readdirSync(FIXTURE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name)
      return {
        path: relative(FIXTURE, absolute).split('\\').join('/'),
        content: readFileSync(absolute, 'utf8'),
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

/** Scanners loaded from the installed packages the build copies the grammars out of. */
export function loadInstalledScanners(): Promise<ScannerSet> {
  return loadArchitectureScanners((asset) =>
    Promise.resolve(readFileSync(require.resolve(asset.module))),
  )
}
