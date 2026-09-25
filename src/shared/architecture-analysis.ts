import type { ArchitectureLayout } from './architecture-layout'

export interface ArchitectureSourceFile {
  readonly path: string
  readonly content: string
  /** Git's blob id for `content` when the capture already holds it. */
  readonly object?: string
}

export interface ArchitectureScanInput {
  readonly files: readonly ArchitectureSourceFile[]
  /**
   * Captured tsconfig, jsconfig and package.json files, which configure TypeScript and
   * JavaScript resolution, go.mod files, which name Go module paths, and Cargo.toml files,
   * which name Rust crates. Absent means none were captured, and the scan discloses what
   * each language resolved without.
   */
  readonly configs?: readonly ArchitectureSourceFile[]
  readonly scope: string
  readonly exclusions: readonly string[]
  /** Names each module's subsystem; absent means ARCHITECTURE_DEFAULT_LAYOUT. */
  readonly layout?: ArchitectureLayout
}

/**
 * How an import is written; `from-import` is Python's `from module import name`, and `mod`
 * is Rust's `mod name;`, which declares a child module that lives in its own file.
 */
export type ArchitectureImportForm =
  | 'import'
  | 'export'
  | 'import-type'
  | 'import-equals'
  | 'dynamic-import'
  | 'require'
  | 'from-import'
  | 'mod'

export interface ArchitectureModule {
  readonly path: string
  readonly system: string
  /** The Subsystem (CONTEXT.md) the module belongs to under the scan's layout. */
  readonly subsystem: string
  readonly hash: string
  readonly symbols: readonly {
    readonly name: string
    readonly line: number
    readonly kind: string
  }[]
}

export interface ArchitectureImportFact {
  /** The file the import is written in. */
  readonly source: string
  /**
   * The module an internal import names: a scanned file, or for Go, whose module is a
   * package directory, the directory holding that package's scanned files.
   */
  readonly target?: string
  readonly specifier: string
  readonly form: ArchitectureImportForm
  readonly kind: 'runtime' | 'type-only'
  readonly resolution: 'internal' | 'external' | 'unresolved'
  readonly line: number
  readonly column: number
}

export interface ArchitectureDiagnostic {
  readonly file: string
  readonly line: number
  readonly message: string
}

export interface ArchitectureScanResult {
  readonly fingerprint: string
  readonly scope: string
  readonly exclusions: readonly string[]
  readonly modules: readonly ArchitectureModule[]
  readonly imports: readonly ArchitectureImportFact[]
  readonly diagnostics: readonly ArchitectureDiagnostic[]
}

export type ArchitectureChange = 'added' | 'removed' | 'changed' | 'unchanged'

export interface ArchitectureModuleDelta extends ArchitectureModule {
  readonly change: ArchitectureChange
}

export interface ArchitectureImportDelta extends ArchitectureImportFact {
  readonly change: ArchitectureChange
  readonly beforeLine?: number
  readonly beforeColumn?: number
}

export interface ArchitectureRelationshipDelta {
  readonly source: string
  readonly target: string
  readonly before: number
  readonly after: number
  readonly change: ArchitectureChange
  readonly evidence: readonly ArchitectureImportDelta[]
}

export interface ArchitectureAnalysis {
  readonly before: ArchitectureScanResult
  readonly after: ArchitectureScanResult
  readonly modules: readonly ArchitectureModuleDelta[]
  readonly imports: readonly ArchitectureImportDelta[]
  readonly relationships: readonly ArchitectureRelationshipDelta[]
}

export const ARCHITECTURE_ANALYSIS_LIMITS = {
  maxImports: 20_000,
  maxSymbolsPerModule: 500,
} as const
