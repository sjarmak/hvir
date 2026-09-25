import { describe, expect, it } from 'vitest'
import {
  inferArchitectureSystems,
  systemOf,
} from '../src/main/architecture-review/system-inference'
import { parseArchitectureLayout } from '../src/shared/architecture-layout'

const source = (path: string) => ({ path, content: '' })
const config = (path: string, content: string) => ({ path, content })
const infer = (
  paths: readonly string[],
  configs: readonly { readonly path: string; readonly content: string }[] = [],
) => inferArchitectureSystems(paths.map(source), configs)

describe('architecture system inference', () => {
  it('falls back to one project system', () => {
    const systems = infer(['src/app.ts', 'tools/release.ts'])
    expect(systems).toEqual([{ name: '(project)', paths: [] }])
    expect(systemOf(systems, 'src/app.ts')).toBe('(project)')
  })

  it('infers npm workspace packages and uses their package names', () => {
    const systems = infer(
      ['packages/app/src/a.ts', 'packages/lib/src/b.ts'],
      [
        config('package.json', '{"workspaces":["packages/*"]}'),
        config('packages/app/package.json', '{"name":"desktop"}'),
        config('packages/lib/package.json', '{"name":"shared-lib"}'),
      ],
    )
    expect(systems).toEqual([
      { name: 'desktop', paths: ['packages/app'] },
      { name: 'shared-lib', paths: ['packages/lib'] },
    ])
  })

  it('infers Electron process and companion systems', () => {
    const systems = infer(
      [
        'src/main/index.ts',
        'src/preload/index.ts',
        'src/renderer/src/App.tsx',
        'src/renderer/companion/index.tsx',
      ],
      [config('package.json', '{"devDependencies":{"electron":"1"}}')],
    )
    expect(systemOf(systems, 'src/main/index.ts')).toBe('main')
    expect(systemOf(systems, 'src/preload/index.ts')).toBe('preload')
    expect(systemOf(systems, 'src/renderer/src/App.tsx')).toBe('renderer')
    expect(systemOf(systems, 'src/renderer/companion/index.tsx')).toBe('companion')
  })

  it('anchors Electron systems beside a nested package manifest', () => {
    const systems = infer(
      ['apps/desktop/src/main/index.ts'],
      [config('apps/desktop/package.json', '{"devDependencies":{"electron-vite":"1"}}')],
    )
    expect(systems).toEqual([{ name: 'main', paths: ['apps/desktop/src/main'] }])
  })

  it('infers Cargo workspace members', () => {
    const systems = infer(
      ['crates/api/src/lib.rs', 'crates/core/src/lib.rs'],
      [
        config('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n'),
        config('crates/api/Cargo.toml', '[package]\nname = "api"\n'),
        config('crates/core/Cargo.toml', '[package]\nname = "core"\n'),
      ],
    )
    expect(systems).toEqual([
      { name: 'api', paths: ['crates/api'] },
      { name: 'core', paths: ['crates/core'] },
    ])
  })

  it('infers Go workspace modules', () => {
    const systems = infer(
      ['apps/api/main.go', 'libs/auth/auth.go'],
      [
        config('go.work', 'go 1.22\nuse (\n  ./apps/api\n  ./libs/auth\n)\n'),
        config('apps/api/go.mod', 'module example.com/api\n'),
        config('libs/auth/go.mod', 'module example.com/auth\n'),
      ],
    )
    expect(systems).toEqual([
      { name: 'api', paths: ['apps/api'] },
      { name: 'auth', paths: ['libs/auth'] },
    ])
  })

  it('uses explicit system names instead of inferred systems', () => {
    const layout = parseArchitectureLayout(
      JSON.stringify({
        version: 1,
        systems: [{ name: 'desktop app', paths: ['src'] }],
      }),
    )
    const systems = inferArchitectureSystems(
      [source('src/main/index.ts')],
      [config('package.json', '{"dependencies":{"electron":"1"}}')],
      layout,
    )
    expect(systems).toEqual([{ name: 'desktop app', paths: ['src'] }])
  })
})
