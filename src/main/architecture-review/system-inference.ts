import type {
  ArchitectureLayout,
  ArchitectureSourceFile,
  ArchitectureSystemRule,
} from '../../shared'

export const ARCHITECTURE_PROJECT_SYSTEM = '(project)'

export function inferArchitectureSystems(
  files: readonly ArchitectureSourceFile[],
  configs: readonly ArchitectureSourceFile[],
  layout?: ArchitectureLayout,
): readonly ArchitectureSystemRule[] {
  if (layout?.systems.length) return layout.systems
  const paths = [...files, ...configs].map((entry) => entry.path)
  const rules = uniqueRules([
    ...workspaceRules(configs, paths),
    ...electronRules(configs, paths),
    ...cargoRules(configs, paths),
    ...goRules(configs, paths),
  ])
  return rules.length ? rules : [{ name: ARCHITECTURE_PROJECT_SYSTEM, paths: [] }]
}

export function systemOf(
  systems: readonly ArchitectureSystemRule[],
  path: string,
): string {
  const matches = systems
    .flatMap((system) => system.paths.map((prefix) => ({ name: system.name, prefix })))
    .filter(({ prefix }) => covers(prefix, path))
    .sort((left, right) => right.prefix.length - left.prefix.length)
  return (
    matches[0]?.name ??
    systems.find((system) => system.paths.length === 0)?.name ??
    ARCHITECTURE_PROJECT_SYSTEM
  )
}

function workspaceRules(
  configs: readonly ArchitectureSourceFile[],
  paths: readonly string[],
): readonly ArchitectureSystemRule[] {
  return configs.flatMap((file) => {
    if (!file.path.endsWith('package.json')) return []
    const value = jsonObject(file.content)
    const workspaces = Array.isArray(value?.workspaces)
      ? value.workspaces
      : jsonObject(value?.workspaces)?.packages
    if (!Array.isArray(workspaces)) return []
    const base = directory(file.path)
    return workspaces
      .filter((entry): entry is string => typeof entry === 'string')
      .flatMap((pattern) => matchingRoots(join(base, pattern), paths))
      .map((path) => ({ name: packageName(configs, path), paths: [path] }))
  })
}

function electronRules(
  configs: readonly ArchitectureSourceFile[],
  paths: readonly string[],
): readonly ArchitectureSystemRule[] {
  const roots = configs.flatMap((file) => {
    if (!file.path.endsWith('package.json')) return []
    const value = jsonObject(file.content)
    const dependencies = {
      ...jsonObject(value?.dependencies),
      ...jsonObject(value?.devDependencies),
    }
    return 'electron' in dependencies || 'electron-vite' in dependencies
      ? [directory(file.path)]
      : []
  })
  const candidates = [
    { name: 'main', path: 'src/main' },
    { name: 'preload', path: 'src/preload' },
    { name: 'renderer', path: 'src/renderer' },
    { name: 'companion', path: 'src/renderer/companion' },
  ] as const
  return roots.flatMap((root) =>
    candidates.flatMap(({ name, path }) => {
      const absolute = join(root, path)
      return paths.some((candidate) => covers(absolute, candidate))
        ? [{ name, paths: [absolute] }]
        : []
    }),
  )
}

function cargoRules(
  configs: readonly ArchitectureSourceFile[],
  paths: readonly string[],
): readonly ArchitectureSystemRule[] {
  return configs.flatMap((file) => {
    if (!file.path.endsWith('Cargo.toml')) return []
    const workspace = section(file.content, 'workspace')
    const members = workspace ? stringArray(workspace, 'members') : []
    const base = directory(file.path)
    return members
      .flatMap((pattern) => matchingRoots(join(base, pattern), paths))
      .map((path) => ({ name: cargoName(configs, path), paths: [path] }))
  })
}

function goRules(
  configs: readonly ArchitectureSourceFile[],
  paths: readonly string[],
): readonly ArchitectureSystemRule[] {
  return configs.flatMap((file) => {
    if (!file.path.endsWith('go.work')) return []
    const base = directory(file.path)
    return goUses(file.content)
      .map((path) => join(base, path.replace(/^\.\//, '')))
      .filter((path) => paths.some((candidate) => covers(path, candidate)))
      .map((path) => ({ name: goName(configs, path), paths: [path] }))
  })
}

function matchingRoots(pattern: string, paths: readonly string[]): readonly string[] {
  if (!pattern.includes('*'))
    return paths.some((path) => covers(pattern, path)) ? [pattern] : []
  const expression = new RegExp(
    `^${pattern.split('*').map(escapeExpression).join('[^/]+')}(?:/|$)`,
  )
  return [
    ...new Set(
      paths.flatMap((path) => expression.exec(path)?.[0]?.replace(/\/$/, '') ?? []),
    ),
  ].sort()
}

function packageName(configs: readonly ArchitectureSourceFile[], path: string): string {
  const manifest = configs.find((file) => file.path === `${path}/package.json`)
  const name = jsonObject(manifest?.content)?.name
  return typeof name === 'string' && name ? name : basename(path)
}

function cargoName(configs: readonly ArchitectureSourceFile[], path: string): string {
  const manifest = configs.find((file) => file.path === `${path}/Cargo.toml`)
  const name = manifest ? scalar(section(manifest.content, 'package'), 'name') : undefined
  return name ?? basename(path)
}

function goName(configs: readonly ArchitectureSourceFile[], path: string): string {
  const manifest = configs.find((file) => file.path === `${path}/go.mod`)
  const module = manifest?.content.match(/^\s*module\s+(\S+)/m)?.[1]
  return module ? basename(module) : basename(path)
}

function goUses(content: string): readonly string[] {
  const block = content.match(/^\s*use\s*\(([^)]*)\)/ms)?.[1]
  const single = [...content.matchAll(/^\s*use\s+(\S+)/gm)].map((match) => match[1]!)
  return [
    ...(block?.split(/\s+/).filter((value) => value && !value.startsWith('//')) ?? []),
    ...single,
  ]
}

function section(content: string, name: string): string {
  return (
    content.match(
      new RegExp(`(?:^|\\n)\\[${name}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`),
    )?.[1] ?? ''
  )
}

function stringArray(content: string, key: string): readonly string[] {
  const match = content.match(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`))?.[1]
  return match ? [...match.matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]!) : []
}

function scalar(content: string, key: string): string | undefined {
  return content.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*["']([^"']+)["']`))?.[1]
}

function uniqueRules(
  rules: readonly ArchitectureSystemRule[],
): readonly ArchitectureSystemRule[] {
  const paths = new Set<string>()
  return rules.filter((rule) => {
    const path = rule.paths[0]
    if (!path || paths.has(path)) return false
    paths.add(path)
    return true
  })
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return jsonObject(JSON.parse(value) as unknown)
    } catch {
      return undefined
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function covers(prefix: string, path: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`)
}

function join(base: string, path: string): string {
  return [base, path].filter(Boolean).join('/')
}

function directory(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
