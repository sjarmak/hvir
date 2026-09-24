import { describe, expect, it } from 'vitest'
import {
  inArchitectureScope,
  isSource,
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
