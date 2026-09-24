import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts']
const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() ?? false

/** An import the bundler keeps: not `import type`, and not only type-only names. */
function isValueImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (!bindings || ts.isNamespaceImport(bindings)) return true
  return bindings.elements.length === 0 || bindings.elements.some((e) => !e.isTypeOnly)
}

function valueSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
  )
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isValueImport(node.importClause))
      found.push((node.moduleSpecifier as ts.StringLiteral).text)
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly)
      found.push((node.moduleSpecifier as ts.StringLiteral).text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      found.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier)
  const hit = EXTENSIONS.map((extension) => base + extension).find(isFile)
  if (!hit) throw new Error(`Unresolved import ${specifier} in ${relative(root, from)}`)
  return hit
}

/** Every chain of value imports from `entry` that ends at the bare package `target`. */
function chainsTo(entry: string, target: string): string[][] {
  const parents = new Map<string, string | undefined>([[entry, undefined]])
  const queue = [entry]
  const chains: string[][] = []
  const chainOf = (file: string): string[] => {
    const chain: string[] = []
    for (let at: string | undefined = file; at; at = parents.get(at))
      chain.unshift(relative(root, at))
    return chain
  }
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const specifier of valueSpecifiers(file)) {
      if (specifier === target) chains.push(chainOf(file))
      if (!specifier.startsWith('.')) continue
      const next = resolveRelative(file, specifier)
      if (parents.has(next)) continue
      parents.set(next, file)
      queue.push(next)
    }
  }
  return chains
}

describe('architecture review in the main process', () => {
  it('never loads the TypeScript compiler; parsing belongs to the utility process', () => {
    expect(chainsTo(join(root, 'src/main/index.ts'), 'typescript')).toEqual([])
  })

  it('never loads web-tree-sitter; grammars run only in the utility process', () => {
    expect(chainsTo(join(root, 'src/main/index.ts'), 'web-tree-sitter')).toEqual([])
  })
})
