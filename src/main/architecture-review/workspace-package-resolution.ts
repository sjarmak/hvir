import { posix } from 'node:path'
import type { ArchitectureSourceFile } from '../../shared'
import { VIRTUAL_ROOT } from './compiler-config'

export interface WorkspacePackageVirtualization {
  readonly files: ReadonlyMap<string, string>
  readonly capturedPath: (resolvedPath: string) => string | undefined
  readonly owns: (specifier: string) => boolean
}

export function virtualizeWorkspacePackages(
  files: ReadonlyMap<string, string>,
  configs: readonly ArchitectureSourceFile[],
): WorkspacePackageVirtualization {
  const virtualFiles = new Map<string, string>()
  const capturedByVirtual = new Map<string, string>()
  const manifests = new Map<string, string>()
  const ambiguous = new Set<string>()
  const captured = [
    ...files,
    ...configs.map((entry) => [entry.path, entry.content] as const),
  ]
  for (const file of configs) {
    if (posix.basename(file.path) !== 'package.json') continue
    const manifest = parseManifest(file.content)
    if (!manifest || typeof manifest.name !== 'string' || !isPackageName(manifest.name))
      continue
    if (manifests.has(manifest.name)) {
      ambiguous.add(manifest.name)
      continue
    }
    manifests.set(manifest.name, posix.dirname(file.path))
  }
  for (const [name, directory] of manifests) {
    if (ambiguous.has(name)) continue
    const root = directory === '.' ? '' : directory
    const prefix = root ? `${root}/` : ''
    for (const [path, content] of captured) {
      if (path !== root && !path.startsWith(prefix)) continue
      const relative = path === root ? '' : path.slice(prefix.length)
      const virtual = posix.join('node_modules', name, relative)
      virtualFiles.set(virtual, content)
      capturedByVirtual.set(posix.join(VIRTUAL_ROOT, virtual), path)
    }
  }
  return {
    files: virtualFiles,
    capturedPath: (path) => capturedByVirtual.get(path),
    owns: (specifier) => {
      const parts = specifier.split('/')
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
      if (!name) return false
      return manifests.has(name) || ambiguous.has(name)
    },
  }
}

function isPackageName(name: string): boolean {
  const parts = name.split('/')
  return (
    (parts.length === 1 || (parts.length === 2 && parts[0]!.startsWith('@'))) &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..') &&
    posix.normalize(name) === name
  )
}

function parseManifest(content: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(content)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined
  } catch {
    return undefined
  }
}
