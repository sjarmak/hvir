import type {
  ArchitectureDiagnostic,
  ArchitectureImportFact,
  ArchitectureSourceFile,
} from '../../shared'
import type { ModuleFacts, ModuleImportOccurrence } from './module-facts'

/**
 * The language-agnostic scan contract (ADR-063): a scanner claims module files by path,
 * turns one module's bytes into facts, and resolves those facts against one scan's files.
 * Parsing sees only the bytes, so its result is cacheable by blob; resolution sees the
 * whole file set of its language and runs on every scan.
 */
export interface LanguageScanner {
  readonly language: string
  /**
   * Names exactly what `parse` extracts. It changes whenever the parser, grammar or
   * extraction changes, and is part of every parse-cache key for this language.
   */
  readonly version: string
  /** The parse kind of a module this scanner reads, or undefined when it is not one. */
  readonly kindOf: (path: string) => string | undefined
  /** Never throws for malformed source: syntax errors become diagnostics. */
  readonly parse: (path: string, content: string) => ModuleFacts
  readonly resolver: (context: ResolutionContext) => ScanResolver
}

export interface ResolutionContext {
  /** Every module of this scanner's language in the scan, by path. */
  readonly modules: ReadonlyMap<string, string>
  /**
   * What each of those modules parsed to. A language whose module tree is declared in the
   * source, as Rust's is by `mod`, resolves against the declarations of every module.
   */
  readonly facts: ReadonlyMap<string, ModuleFacts>
  /** Captured configuration files; a scanner reads only the ones it understands. */
  readonly configs: readonly ArchitectureSourceFile[]
}

export interface ScanResolver {
  /** One occurrence may name several modules, as `from pkg import a, b` does. */
  readonly resolve: (
    source: string,
    occurrence: ModuleImportOccurrence,
  ) => readonly ArchitectureImportFact[]
  /** What the scan should know about resolution as a whole, such as ignored configs. */
  readonly diagnostics: readonly ArchitectureDiagnostic[]
}

export interface ScannerMatch {
  readonly scanner: LanguageScanner
  readonly kind: string
}

export interface ScannerSet {
  readonly scanners: readonly LanguageScanner[]
  readonly scannerFor: (path: string) => ScannerMatch | undefined
}

/** The first scanner that claims a path reads it; languages never share an extension. */
export function scannerSet(scanners: readonly LanguageScanner[]): ScannerSet {
  const languages = scanners.map((scanner) => scanner.language)
  if (new Set(languages).size !== languages.length)
    throw new Error(`Duplicate architecture scanner language: ${languages.join(', ')}`)
  return {
    scanners: [...scanners],
    scannerFor: (path) => {
      for (const scanner of scanners) {
        const kind = scanner.kindOf(path)
        if (kind) return { scanner, kind }
      }
      return undefined
    },
  }
}
