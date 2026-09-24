import { createHash } from 'node:crypto'
import { Language, Parser } from 'web-tree-sitter'
import { GO_FACTS_REVISION, parseGoFacts } from './go-facts'
import { goResolver } from './go-resolution'
import { scannerSet, type LanguageScanner, type ScannerSet } from './language-scanner'
import type { ModuleFacts } from './module-facts'
import { parsePythonFacts, PYTHON_FACTS_REVISION } from './python-facts'
import { pythonResolver } from './python-resolution'
import { TREE_SITTER_ASSETS, type TreeSitterAsset } from './tree-sitter-assets'
import { TYPESCRIPT_SCANNER } from './typescript-scanner'

/** Reads one packaged WebAssembly asset; the worker reads through LocalHost. */
export type ScannerAssetReader = (asset: TreeSitterAsset) => Promise<Uint8Array>

let runtime: Promise<void> | undefined

/** A web-tree-sitter language: its grammar, and how its modules become facts. */
interface GrammarLanguage {
  readonly language: string
  readonly asset: TreeSitterAsset
  readonly revision: string
  readonly extension: string
  readonly parse: (parser: Parser, content: string) => ModuleFacts
  readonly resolver: LanguageScanner['resolver']
}

const GRAMMAR_LANGUAGES: readonly GrammarLanguage[] = [
  {
    language: 'python',
    asset: TREE_SITTER_ASSETS.python,
    revision: PYTHON_FACTS_REVISION,
    extension: '.py',
    parse: parsePythonFacts,
    resolver: pythonResolver,
  },
  {
    language: 'go',
    asset: TREE_SITTER_ASSETS.go,
    revision: GO_FACTS_REVISION,
    extension: '.go',
    parse: parseGoFacts,
    resolver: goResolver,
  },
]

/**
 * Every scanner this build ships (ADR-063): TypeScript through the compiler, then Python
 * and Go through web-tree-sitter. The bytes are passed in, so emscripten never looks for a
 * file.
 */
export async function loadArchitectureScanners(
  read: ScannerAssetReader,
): Promise<ScannerSet> {
  const [runtimeBytes, ...grammarBytes] = await Promise.all([
    readAsset(read, TREE_SITTER_ASSETS.runtime),
    ...GRAMMAR_LANGUAGES.map((entry) => readAsset(read, entry.asset)),
  ])
  await initRuntime(runtimeBytes)
  const grammarScanners = await Promise.all(
    GRAMMAR_LANGUAGES.map((entry, index) =>
      grammarScanner(entry, runtimeBytes, grammarBytes[index]!),
    ),
  )
  return scannerSet([TYPESCRIPT_SCANNER, ...grammarScanners])
}

/** One parser per language; the version names the exact runtime and grammar bytes. */
async function grammarScanner(
  entry: GrammarLanguage,
  runtimeBytes: Uint8Array,
  grammarBytes: Uint8Array,
): Promise<LanguageScanner> {
  const parser = new Parser()
  parser.setLanguage(await loadGrammar(entry.asset, grammarBytes))
  const digest = createHash('sha256')
    .update(runtimeBytes)
    .update(grammarBytes)
    .digest('hex')
    .slice(0, 16)
  return {
    language: entry.language,
    version: `${entry.revision}+wasm-${digest}`,
    kindOf: (path) => (path.endsWith(entry.extension) ? entry.extension : undefined),
    parse: (_path, content) => entry.parse(parser, content),
    resolver: entry.resolver,
  }
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

async function readAsset(
  read: ScannerAssetReader,
  asset: TreeSitterAsset,
): Promise<Uint8Array> {
  try {
    return await read(asset)
  } catch (error) {
    throw new Error(
      `Architecture scanner asset ${asset.file} could not be read: ${message(error)}`,
      { cause: error },
    )
  }
}

/** The runtime initializes once per process; a failed start is retried by the next load. */
function initRuntime(bytes: Uint8Array): Promise<void> {
  runtime ??= Parser.init({ wasmBinary: bytes }).catch((error: unknown) => {
    runtime = undefined
    throw new Error(
      `Architecture scanner runtime ${TREE_SITTER_ASSETS.runtime.file} failed to start: ${message(error)}`,
      { cause: error },
    )
  })
  return runtime
}

async function loadGrammar(asset: TreeSitterAsset, bytes: Uint8Array): Promise<Language> {
  try {
    return await Language.load(bytes)
  } catch (error) {
    throw new Error(
      `Architecture scanner grammar ${asset.file} failed to load: ${message(error)}`,
      { cause: error },
    )
  }
}
