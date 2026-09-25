import type { ArchitectureImportForm, ArchitectureModule } from '../../shared'

/** One import as written in a module, before it is resolved against any file set. */
export interface ModuleImportOccurrence {
  /** Absent for a computed specifier such as `import(name)`. */
  readonly specifier?: string
  readonly form: ArchitectureImportForm
  /**
   * The names a Python from-import brings in, `*` for a wildcard. Resolution needs them:
   * `from pkg import mod` imports the submodule `pkg.mod` when that module exists.
   */
  readonly names?: readonly string[]
  /** The Rust inline modules (`mod a { ... }`) it is written inside, outermost first. */
  readonly scope?: readonly string[]
  /** A Rust `mod` declaration's `#[path = "..."]` attribute, as written. */
  readonly pathAttribute?: string
  readonly typeOnly: boolean
  readonly line: number
  readonly column: number
}

/**
 * Everything a scan learns from one module's bytes alone, in any language. It depends only
 * on the content, the parse kind and the scanner, so it can be cached by blob id;
 * resolution happens per scan.
 */
export interface ModuleFacts {
  readonly symbols: ArchitectureModule['symbols']
  readonly imports: readonly ModuleImportOccurrence[]
  readonly diagnostics: readonly { readonly line: number; readonly message: string }[]
}

const FORMS: ReadonlySet<string> = new Set<ArchitectureImportForm>([
  'import',
  'export',
  'import-type',
  'import-equals',
  'dynamic-import',
  'require',
  'from-import',
  'mod',
])
const isPosition = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isOptionalStrings = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.every((name) => typeof name === 'string'))

function isOccurrence(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    (entry.specifier === undefined || typeof entry.specifier === 'string') &&
    typeof entry.form === 'string' &&
    FORMS.has(entry.form) &&
    isOptionalStrings(entry.names) &&
    isOptionalStrings(entry.scope) &&
    (entry.pathAttribute === undefined || typeof entry.pathAttribute === 'string') &&
    typeof entry.typeOnly === 'boolean' &&
    isPosition(entry.line) &&
    isPosition(entry.column)
  )
}

/** Structural check for facts read back from disk; anything else is discarded. */
export function isModuleFacts(value: unknown): value is ModuleFacts {
  if (!isRecord(value)) return false
  const { symbols, imports, diagnostics } = value
  return (
    Array.isArray(symbols) &&
    symbols.every(
      (symbol) =>
        isRecord(symbol) &&
        typeof symbol.name === 'string' &&
        typeof symbol.kind === 'string' &&
        isPosition(symbol.line),
    ) &&
    Array.isArray(imports) &&
    imports.every(isOccurrence) &&
    Array.isArray(diagnostics) &&
    diagnostics.every(
      (entry) =>
        isRecord(entry) && typeof entry.message === 'string' && isPosition(entry.line),
    )
  )
}
