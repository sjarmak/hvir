import { createHash } from 'node:crypto'
import { Language, Parser } from 'web-tree-sitter'
import { scannerSet, type LanguageScanner, type ScannerSet } from './language-scanner'
import { parsePythonFacts, PYTHON_FACTS_REVISION } from './python-facts'
import { pythonResolver } from './python-resolution'
import { TREE_SITTER_ASSETS, type TreeSitterAsset } from './tree-sitter-assets'
import { TYPESCRIPT_SCANNER } from './typescript-scanner'

/** Reads one packaged WebAssembly asset; the worker reads through LocalHost. */
export type ScannerAssetReader = (asset: TreeSitterAsset) => Promise<Uint8Array>

let runtime: Promise<void> | undefined

/**
 * Every scanner this build ships (ADR-063): TypeScript through the compiler and Python
 * through web-tree-sitter. The bytes are passed in, so emscripten never looks for a file.
 */
export async function loadArchitectureScanners(
  read: ScannerAssetReader,
): Promise<ScannerSet> {
  const [runtimeBytes, grammarBytes] = await Promise.all([
    readAsset(read, TREE_SITTER_ASSETS.runtime),
    readAsset(read, TREE_SITTER_ASSETS.python),
  ])
  await initRuntime(runtimeBytes)
  const parser = new Parser()
  parser.setLanguage(await loadGrammar(TREE_SITTER_ASSETS.python, grammarBytes))
  const digest = createHash('sha256')
    .update(runtimeBytes)
    .update(grammarBytes)
    .digest('hex')
    .slice(0, 16)
  return scannerSet([
    TYPESCRIPT_SCANNER,
    pythonScanner(parser, `${PYTHON_FACTS_REVISION}+wasm-${digest}`),
  ])
}

function pythonScanner(parser: Parser, version: string): LanguageScanner {
  return {
    language: 'python',
    version,
    kindOf: (path) => (path.endsWith('.py') ? '.py' : undefined),
    parse: (_path, content) => parsePythonFacts(parser, content),
    resolver: pythonResolver,
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
