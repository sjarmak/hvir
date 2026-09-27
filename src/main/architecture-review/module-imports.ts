import type { ArchitectureSourceFile } from '../../shared/architecture-analysis'
import type { HostPath } from '../../shared/host-path'
import { gitBlobId } from './blob-id'
import { cachedFactsSource } from './cached-facts'
import { COMMIT_CHANGE_CLASSIFIER_VERSION, type ImportSignature } from './commit-change'
import type { ScannerSet } from './language-scanner'
import type { ModuleFactsCache } from './module-facts-cache'

export interface ModuleImports {
  readonly object: string
  readonly imports: readonly ImportSignature[] | null
}
export interface ModuleImportsResult {
  readonly scanners: string
  readonly imports: readonly ModuleImports[]
}

export async function readModuleImports(
  sources: readonly ArchitectureSourceFile[],
  root: HostPath,
  cache: ModuleFactsCache | undefined,
  scanners: ScannerSet,
): Promise<ModuleImportsResult> {
  const facts = cachedFactsSource(cache, root, scanners)
  const distinct = [
    ...new Map(sources.map((source) => [blobOf(source), source])).entries(),
  ]
  await facts.load(distinct.map(([, source]) => source))
  const imports = distinct.map(([object, source]): ModuleImports => {
    const match = scanners.scannerFor(source.path)
    if (!match) return { object, imports: null }
    const parsed = facts.factsOf({
      path: source.path,
      content: source.content,
      blob: object,
      scanner: match.scanner,
      kind: match.kind,
    })
    return {
      object,
      imports: parsed.imports.map((occurrence) => ({
        ...(occurrence.specifier === undefined
          ? {}
          : { specifier: occurrence.specifier }),
        form: occurrence.form,
        typeOnly: occurrence.typeOnly,
      })),
    }
  })
  await facts.flush()
  return { scanners: scannerFingerprint(scanners), imports }
}

export function scannerFingerprint(scanners: ScannerSet): string {
  return [
    COMMIT_CHANGE_CLASSIFIER_VERSION,
    ...scanners.scanners.map((scanner) => `${scanner.language}=${scanner.version}`),
  ].join(';')
}

const blobOf = (source: ArchitectureSourceFile): string =>
  source.object ?? gitBlobId(Buffer.from(source.content, 'utf8'))
