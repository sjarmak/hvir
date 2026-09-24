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
})
