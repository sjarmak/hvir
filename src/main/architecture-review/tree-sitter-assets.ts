/**
 * The WebAssembly files the grammar scanners load (ADR-063). The build copies each `module`
 * into `TREE_SITTER_ASSET_DIRECTORY` next to the main bundle; they ship inside app.asar,
 * which the utility process reads like any other file, so no asarUnpack entry is needed.
 */
export interface TreeSitterAsset {
  /** The file name inside `TREE_SITTER_ASSET_DIRECTORY`. */
  readonly file: string
  /** The package path the build copies it from. */
  readonly module: string
}

export const TREE_SITTER_ASSET_DIRECTORY = 'tree-sitter'

export const TREE_SITTER_ASSETS = {
  runtime: {
    file: 'web-tree-sitter.wasm',
    module: 'web-tree-sitter/web-tree-sitter.wasm',
  },
  python: {
    file: 'tree-sitter-python.wasm',
    module: 'tree-sitter-python/tree-sitter-python.wasm',
  },
  go: {
    file: 'tree-sitter-go.wasm',
    module: 'tree-sitter-go/tree-sitter-go.wasm',
  },
} as const satisfies Readonly<Record<string, TreeSitterAsset>>
