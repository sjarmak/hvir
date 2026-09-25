import { describe, expect, it } from 'vitest'
import {
  inArchitectureScope,
  isSource,
  parseTree,
  selectEntries,
} from '../src/main/architecture-review/capture-entries'

describe('architecture capture scope', () => {
  it('captures Python modules as sources alongside TypeScript and JavaScript', () => {
    expect(isSource('app/core/engine.py')).toBe(true)
    expect(isSource('app/__init__.py')).toBe(true)
    expect(isSource('src/a.ts')).toBe(true)
    expect(isSource('src/a.d.ts')).toBe(false)
    expect(isSource('app/stub.pyi')).toBe(false)
    expect(isSource('pyproject.toml')).toBe(false)
    expect(inArchitectureScope('app/core/engine.py')).toBe(true)
    expect(inArchitectureScope('tsconfig.json')).toBe(true)
  })

  it('captures Go files as sources and every go.mod as a config', () => {
    expect(isSource('cmd/shop/main.go')).toBe(true)
    expect(isSource('internal/store/store_test.go')).toBe(true)
    expect(isSource('go.mod')).toBe(false)
    expect(inArchitectureScope('go.mod')).toBe(true)
    expect(inArchitectureScope('tools/go.mod')).toBe(true)
    expect(inArchitectureScope('go.sum')).toBe(false)
    expect(inArchitectureScope('notgo.mod')).toBe(false)
    expect(inArchitectureScope('vendor/github.com/google/uuid/uuid.go')).toBe(false)
  })

  it('captures Rust files as sources and every Cargo.toml as a config', () => {
    expect(isSource('shop/src/lib.rs')).toBe(true)
    expect(isSource('Cargo.toml')).toBe(false)
    expect(inArchitectureScope('Cargo.toml')).toBe(true)
    expect(inArchitectureScope('crates/shop/Cargo.toml')).toBe(true)
    expect(inArchitectureScope('Cargo.lock')).toBe(false)
    expect(inArchitectureScope('pyproject.toml')).toBe(false)
  })

  it('leaves out only the target directory beside a Cargo.toml, which is Cargo build output', () => {
    const selected = (paths: readonly string[]) =>
      selectEntries(paths.map((path) => ({ path }))).map((entry) => entry.path)
    expect(
      selected([
        'Cargo.toml',
        'src/lib.rs',
        'target/debug/build/shop-1/out/codes.rs',
        'target/package/shop-0.1.0/Cargo.toml',
        'target/package/shop-0.1.0/src/lib.rs',
        'src/target/mod.rs',
        'src/target.rs',
        'crates/shop/Cargo.toml',
        'crates/shop/target/debug/out.rs',
        'crates/shop/src/target/mod.rs',
        'web/target/index.ts',
        'docs/target/tool.py',
      ]),
    ).toEqual([
      'Cargo.toml',
      'crates/shop/Cargo.toml',
      'crates/shop/src/target/mod.rs',
      'docs/target/tool.py',
      'src/lib.rs',
      'src/target.rs',
      'src/target/mod.rs',
      'web/target/index.ts',
    ])
  })

  it('keeps a target directory where no Cargo.toml sits beside it', () => {
    expect(
      selectEntries([{ path: 'target/a.ts' }, { path: 'lib/target/b.rs' }]).map(
        (entry) => entry.path,
      ),
    ).toEqual(['lib/target/b.rs', 'target/a.ts'])
  })

  it('still leaves out environments and dependency trees beside a Cargo.toml', () => {
    expect(
      selectEntries(
        [
          'Cargo.toml',
          'node_modules/pkg/index.ts',
          '.venv/lib/site.py',
          'venv/lib/python3.12/site-packages/x.py',
          'vendor/crate/src/lib.rs',
          'src/node_modules/x.ts',
        ].map((path) => ({ path })),
      ).map((entry) => entry.path),
    ).toEqual(['Cargo.toml'])
  })

  it('leaves out Python environments and bytecode caches', () => {
    expect(inArchitectureScope('.venv/lib/site.py')).toBe(false)
    expect(inArchitectureScope('.tox/py312/lib/a.py')).toBe(false)
    expect(inArchitectureScope('app/__pycache__/engine.py')).toBe(false)
  })

  it('leaves out a virtualenv named venv and installed packages under any environment name', () => {
    expect(inArchitectureScope('venv/lib/python3.12/site-packages/x.py')).toBe(false)
    expect(inArchitectureScope('venv/bin/activate_this.py')).toBe(false)
    expect(inArchitectureScope('env/lib/python3.12/site-packages/x.py')).toBe(false)
    expect(inArchitectureScope('site-packages/x.py')).toBe(false)
    expect(inArchitectureScope('.nox/tests/lib/a.py')).toBe(false)
    expect(inArchitectureScope('.mypy_cache/x.py')).toBe(false)
    expect(inArchitectureScope('.pytest_cache/a.py')).toBe(false)
  })

  it('keeps first-party directories that merely share a common name', () => {
    // `env` is a usual home for configuration modules, so it is matched only through site-packages.
    expect(inArchitectureScope('src/env/index.ts')).toBe(true)
    expect(inArchitectureScope('app/env.py')).toBe(true)
    expect(inArchitectureScope('src/venvironment/a.ts')).toBe(true)
  })
})

describe('Git tree listing', () => {
  const blob = 'a'.repeat(40)
  it('keeps the blob size a long listing carries, so the byte cap needs no content', () => {
    const output = [
      `100644 blob ${blob}    1234\tsrc/a b.ts`,
      `160000 commit ${blob}       -\tvendor/lib`,
      `100644 blob ${blob}\tsrc/short.ts`,
    ].join('\0')
    expect(parseTree(output + '\0')).toEqual([
      { path: 'src/a b.ts', object: blob, mode: '100644', size: 1234 },
      { path: 'vendor/lib', object: blob, mode: '160000' },
      { path: 'src/short.ts', object: blob, mode: '100644' },
    ])
  })
  it('refuses a record it cannot read', () => {
    expect(() => parseTree('garbage\0')).toThrow('Invalid Git tree entry')
  })
})
