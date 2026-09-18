/**
 * The Companion phone page is a second renderer entry that must stay a
 * strict observer: it talks to the loopback listener over fetch and reads the
 * event stream with the bearer in a header. It never reaches the desktop
 * bridge, the desktop renderer tree, or EventSource (ADR-049).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const PAGE_ROOT = resolve(ROOT, 'src/renderer/companion')
const SHARED_ROOT = resolve(ROOT, 'src/shared')
const ALLOWED_BARE_IMPORTS = new Set(['react', 'react-dom/client'])
/** The emulator and its module, admitted for the one adapter that owns them (ADR-050). */
const GHOSTTY_IMPORTS = new Set(['ghostty-web', 'ghostty-web/ghostty-vt.wasm?url'])
const GHOSTTY_ADAPTER = 'src/ghostty-companion-pane.ts'
const IMPORT_PATTERN =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function sourceFiles(): string[] {
  return walk(PAGE_ROOT).filter((path) => /\.(ts|tsx)$/.test(path))
}

function importSpecifiers(path: string): string[] {
  const text = readFileSync(path, 'utf8')
  return [...text.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? match[2] ?? '')
}

/** The root itself counts: `../../../shared` names the barrel, not a parent. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !rel.startsWith('..')
}

describe('Companion page boundary', () => {
  it('has a page tree with an entry and at least one module', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(0)
    expect(files.map((path) => relative(PAGE_ROOT, path))).toContain('src/main.tsx')
  })

  it('imports only from its own tree, src/shared, react and react-dom/client', () => {
    const offenders: string[] = []
    for (const path of sourceFiles()) {
      const adapter = relative(PAGE_ROOT, path) === GHOSTTY_ADAPTER
      for (const specifier of importSpecifiers(path)) {
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(path), specifier)
          const inside = isInside(PAGE_ROOT, target) || isInside(SHARED_ROOT, target)
          if (!inside) offenders.push(`${relative(ROOT, path)} -> ${specifier}`)
        } else if (adapter && GHOSTTY_IMPORTS.has(specifier)) {
          continue
        } else if (!ALLOWED_BARE_IMPORTS.has(specifier)) {
          offenders.push(`${relative(ROOT, path)} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('ghostty-web is imported only by the pane adapter', () => {
    const importers = sourceFiles().filter((path) =>
      importSpecifiers(path).some((specifier) => specifier.startsWith('ghostty-web')),
    )
    expect(importers.map((path) => relative(PAGE_ROOT, path))).toEqual([GHOSTTY_ADAPTER])
    expect(importSpecifiers(join(PAGE_ROOT, GHOSTTY_ADAPTER))).toContain(
      'ghostty-web/ghostty-vt.wasm?url',
    )
  })

  it('never reaches the desktop bridge, the desktop renderer, or EventSource', () => {
    const offenders: string[] = []
    for (const path of walk(PAGE_ROOT)) {
      const text = readFileSync(path, 'utf8')
      for (const banned of [
        'window.hvir',
        'EventSource',
        '/renderer/src/',
        'ipcRenderer',
      ]) {
        if (text.includes(banned))
          offenders.push(`${relative(ROOT, path)} contains ${banned}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('declares the observer CSP with wasm execution and a page-relative entry script', () => {
    const html = readFileSync(join(PAGE_ROOT, 'index.html'), 'utf8')
    expect(html).toContain(
      `content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"`,
    )
    expect(html).toContain('src="./src/main.tsx"')
    expect(html).not.toContain('src="/src/main.tsx"')
    expect(html).toContain('name="viewport"')
  })

  it('is a second renderer input beside the desktop page', () => {
    const config = readFileSync(resolve(ROOT, 'electron.vite.config.ts'), 'utf8')
    expect(config).toContain(`companion: resolve('src/renderer/companion/index.html')`)
  })

  it('keeps every page file under the size cap', () => {
    for (const path of sourceFiles()) {
      const lines = readFileSync(path, 'utf8').split('\n').length
      expect(lines, relative(ROOT, path)).toBeLessThanOrEqual(500)
    }
  })
})
