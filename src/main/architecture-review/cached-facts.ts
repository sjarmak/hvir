import type { ArchitectureDiagnostic, ArchitectureSourceFile } from '../../shared'
import type { HostPath } from '../../shared/host-path'
import { gitBlobId } from './blob-id'
import type { ModuleFactsSource } from './analysis'
import type { LanguageScanner, ScannerSet } from './language-scanner'
import type { ModuleFactsCache, ModuleFactsKey } from './module-facts-cache'
import type { ModuleFacts } from './module-facts'

/** Cache reads and writes in flight at once; the files are small and local. */
const CONCURRENCY = 32

export interface CachedFactsSource {
  /** Looks every source up before a synchronous scan; a hit is then only a map read. */
  readonly load: (sources: readonly ArchitectureSourceFile[]) => Promise<void>
  readonly factsOf: ModuleFactsSource
  /** Writes what the scan had to parse, so the next scan finds it. */
  readonly flush: () => Promise<void>
  /** Cache failures since the last call, as scan diagnostics; each is reported once. */
  readonly takeDiagnostics: () => readonly ArchitectureDiagnostic[]
}

/**
 * Facts for one analysis: a blob seen on either end is parsed at most once, and a blob any
 * earlier scan of this repository parsed is a disk lookup. A cache that fails is disclosed
 * as a diagnostic and bypassed for the rest of the analysis; the scan never depends on it.
 */
export function cachedFactsSource(
  cache: ModuleFactsCache | undefined,
  root: HostPath,
  scanners: ScannerSet,
): CachedFactsSource {
  const seen = new Map<string, ModuleFacts>()
  const parsed = new Map<string, { key: ModuleFactsKey; facts: ModuleFacts }>()
  const pending: ArchitectureDiagnostic[] = []
  let disk = cache
  const keyOf = (
    scanner: LanguageScanner,
    kind: string,
    blob: string,
  ): ModuleFactsKey => ({
    hostId: root.hostId,
    repository: root.path,
    blob,
    kind,
    scanner: scanner.version,
  })
  const guarded = async (operation: (usable: ModuleFactsCache) => Promise<void>) => {
    if (!disk) return
    try {
      await operation(disk)
    } catch (error) {
      disk = undefined
      const reason = error instanceof Error ? error.message : String(error)
      pending.push({
        file: '(parse cache)',
        line: 1,
        message: `Parse cache unavailable, modules were parsed: ${reason}`,
      })
    }
  }
  const load = async (sources: readonly ArchitectureSourceFile[]) => {
    const wanted = new Map<string, ModuleFactsKey>()
    for (const source of sources) {
      const match = scanners.scannerFor(source.path)
      if (!match) continue
      const key = keyOf(
        match.scanner,
        match.kind,
        source.object ?? blobOf(source.content),
      )
      const memo = `${key.blob}${key.kind}`
      if (!seen.has(memo)) wanted.set(memo, key)
    }
    await guarded((usable) =>
      eachBounded([...wanted], async ([memo, key]) => {
        const facts = await usable.lookup(key)
        if (facts) seen.set(memo, facts)
      }),
    )
  }
  const factsOf: ModuleFactsSource = (source) => {
    const key = keyOf(source.scanner, source.kind, source.blob)
    const memo = `${key.blob}${key.kind}`
    const known = seen.get(memo)
    if (known) return known
    const facts = source.scanner.parse(source.path, source.content)
    seen.set(memo, facts)
    parsed.set(memo, { key, facts })
    return facts
  }
  const flush = async () => {
    const written = [...parsed.values()]
    parsed.clear()
    await guarded((usable) =>
      eachBounded(written, ({ key, facts }) => usable.store(key, facts)),
    )
  }
  return { load, factsOf, flush, takeDiagnostics: () => pending.splice(0) }
}

const blobOf = (content: string): string => gitBlobId(Buffer.from(content, 'utf8'))

/** Runs `work` over `items` with bounded concurrency; the first failure stops new work. */
async function eachBounded<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  let failed = false
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next]!
      next += 1
      try {
        await work(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane))
}
