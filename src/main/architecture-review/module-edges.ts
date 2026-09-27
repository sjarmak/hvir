import type { ArchitectureSourceFile } from '../../shared/architecture-analysis'
import type { HostPath } from '../../shared/host-path'
import { gitBlobId } from './blob-id'
import { cachedFactsSource } from './cached-facts'
import { COMMIT_CHANGE_CLASSIFIER_VERSION, edgeKey } from './commit-change'
import type { LanguageScanner, ScannerSet } from './language-scanner'
import type { ModuleFacts } from './module-facts'
import type { ModuleFactsCache } from './module-facts-cache'

export interface ModuleSide {
  readonly revision: string
  readonly modules: readonly string[]
  readonly configs: readonly ArchitectureSourceFile[]
}
export interface ModuleSource extends ArchitectureSourceFile {
  readonly side: string
}
export interface ModuleEdgesRequest {
  readonly sides: readonly ModuleSide[]
  readonly sources: readonly ModuleSource[]
}
export interface ModuleEdges {
  readonly side: string
  readonly path: string
  readonly object: string
  readonly edges: readonly string[] | null
  readonly needsFacts?: true
}
export interface ModuleEdgesResult {
  readonly scanners: string
  readonly edges: readonly ModuleEdges[]
}

export async function readModuleEdges(
  request: ModuleEdgesRequest,
  root: HostPath,
  cache: ModuleFactsCache | undefined,
  scanners: ScannerSet,
): Promise<ModuleEdgesResult> {
  const facts = cachedFactsSource(cache, root, scanners)
  const sides = new Map(request.sides.map((side) => [side.revision, side]))
  const sources = [
    ...new Map(request.sources.map((source) => [identityOf(source), source])).values(),
  ]
  await facts.load(sources)
  const claimed = new Map<string, Claimed>()
  for (const source of sources) {
    const match = scanners.scannerFor(source.path)
    if (!match) continue
    const object = blobOf(source)
    claimed.set(identityOf(source), {
      source,
      object,
      scanner: match.scanner,
      facts: facts.factsOf({
        path: source.path,
        content: source.content,
        blob: object,
        scanner: match.scanner,
        kind: match.kind,
      }),
    })
  }
  const resolvers = new Map<string, ReturnType<LanguageScanner['resolver']>>()
  const resolverFor = (side: ModuleSide, scanner: LanguageScanner) => {
    const key = `${side.revision}\0${scanner.language}`
    const known = resolvers.get(key)
    if (known) return known
    const own = [...claimed.values()].filter(
      (entry) => entry.source.side === side.revision && entry.scanner === scanner,
    )
    const modules = new Map(
      side.modules
        .filter((path) => scanner.kindOf(path) !== undefined)
        .map((path): [string, string] => [path, '']),
    )
    for (const entry of own) modules.set(entry.source.path, entry.source.content)
    const resolver = scanner.resolver({
      modules,
      facts: new Map(own.map((entry) => [entry.source.path, entry.facts])),
      configs: side.configs,
    })
    resolvers.set(key, resolver)
    return resolver
  }
  const edges = sources.map((source): ModuleEdges => {
    const identity = { side: source.side, path: source.path, object: blobOf(source) }
    const entry = claimed.get(identityOf(source))
    if (!entry) return { ...identity, edges: null }
    if (entry.scanner.resolvesFromFacts)
      return { ...identity, edges: null, needsFacts: true }
    const side = sides.get(source.side)
    if (!side) throw new Error(`Module edges request names no side ${source.side}`)
    const resolver = resolverFor(side, entry.scanner)
    const targets = entry.facts.imports.flatMap((occurrence) =>
      resolver
        .resolve(source.path, occurrence)
        .map((fact) => fact.target ?? `${fact.resolution}: ${fact.specifier}`),
    )
    return { ...identity, edges: [...new Set(targets)].sort() }
  })
  await facts.flush()
  return { scanners: scannerFingerprint(scanners), edges }
}

export function scannerFingerprint(scanners: ScannerSet): string {
  return [
    COMMIT_CHANGE_CLASSIFIER_VERSION,
    ...scanners.scanners.map((scanner) => `${scanner.language}=${scanner.version}`),
  ].join(';')
}

interface Claimed {
  readonly source: ModuleSource
  readonly object: string
  readonly scanner: LanguageScanner
  readonly facts: ModuleFacts
}

const blobOf = (source: ArchitectureSourceFile): string =>
  source.object ?? gitBlobId(Buffer.from(source.content, 'utf8'))

const identityOf = (source: ModuleSource): string =>
  edgeKey(source.side, source.path, blobOf(source))
