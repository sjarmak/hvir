import { describe, expect, it } from 'vitest'
import {
  ARCHITECTURE_DEFAULT_LAYOUT,
  ARCHITECTURE_LAYOUT_FILE,
  inLayoutScope,
  parseArchitectureLayout,
  subsystemOf,
} from '../src/shared/architecture-layout'

const parse = (value: unknown) => parseArchitectureLayout(JSON.stringify(value))
const problem = (value: unknown) => {
  try {
    parse(value)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the layout to be refused')
}

describe('architecture layout file', () => {
  it('is one tracked JSON file at the scan root', () => {
    expect(ARCHITECTURE_LAYOUT_FILE).toBe('.hvir/architecture.json')
  })

  it('reads version, scope, source roots and subsystem rules', () => {
    expect(
      parse({
        version: 1,
        scope: ['src', 'test/unit'],
        sourceRoots: ['src', 'packages/app/src'],
        subsystems: [{ name: 'ui', paths: ['src/renderer', 'src/preload'] }],
      }),
    ).toEqual({
      origin: 'override',
      scope: ['src', 'test/unit'],
      sourceRoots: ['src', 'packages/app/src'],
      subsystems: [{ name: 'ui', paths: ['src/renderer', 'src/preload'] }],
    })
  })

  it('keeps the defaults for anything the file leaves out', () => {
    expect(parse({ version: 1 })).toEqual({
      ...ARCHITECTURE_DEFAULT_LAYOUT,
      origin: 'override',
    })
    expect(ARCHITECTURE_DEFAULT_LAYOUT).toEqual({
      origin: 'default',
      scope: [],
      sourceRoots: ['src'],
      subsystems: [],
    })
  })

  it('refuses malformed JSON and anything but an object of known keys', () => {
    expect(() => parseArchitectureLayout('{ nope')).toThrow(/not valid JSON/)
    expect(problem([])).toMatch(/must be a JSON object/)
    expect(problem({ version: 1, subsystem: [] })).toMatch(/unknown key "subsystem"/)
    expect(problem({})).toMatch(/"version" must be 1/)
    expect(problem({ version: 2 })).toMatch(/"version" must be 1/)
  })

  it('refuses paths that are not plain repository-relative directories or files', () => {
    for (const path of ['', '/abs', 'a/../b', './a', 'a/', 'a//b', 'a\\b', '.', 'a\nb'])
      expect(problem({ version: 1, scope: [path] })).toMatch(/"scope\[0\]"/)
    expect(problem({ version: 1, sourceRoots: ['src', 'src'] })).toMatch(
      /"sourceRoots\[1\]" repeats "src"/,
    )
    expect(problem({ version: 1, scope: [] })).toMatch(
      /"scope" must list at least one path; leave it out to scan the whole repository/,
    )
    expect(problem({ version: 1, scope: 'src' })).toMatch(/"scope" must be an array/)
  })

  it('refuses subsystem rules that are ambiguous or unnamed', () => {
    expect(problem({ version: 1, subsystems: [{ name: 'a' }] })).toMatch(
      /"subsystems\[0\].paths" must be an array/,
    )
    expect(
      problem({ version: 1, subsystems: [{ name: 'a', paths: ['x'], owner: 'me' }] }),
    ).toMatch(/"subsystems\[0\]" has unknown key "owner"/)
    expect(problem({ version: 1, subsystems: [{ name: ' ', paths: ['x'] }] })).toMatch(
      /"subsystems\[0\].name"/,
    )
    expect(
      problem({ version: 1, subsystems: [{ name: 'external: x', paths: ['x'] }] }),
    ).toMatch(/"subsystems\[0\].name" cannot start with "external:"/)
    expect(
      problem({
        version: 1,
        subsystems: [
          { name: 'a', paths: ['x'] },
          { name: 'a', paths: ['y'] },
        ],
      }),
    ).toMatch(/"subsystems\[1\].name" repeats "a"/)
    expect(
      problem({
        version: 1,
        subsystems: [
          { name: 'a', paths: ['x'] },
          { name: 'b', paths: ['x'] },
        ],
      }),
    ).toMatch(/"subsystems\[1\].paths\[0\]" is already mapped to "a"/)
  })

  it('refuses an oversized file before parsing it', () => {
    expect(() => parseArchitectureLayout(' '.repeat(64 * 1024 + 1))).toThrow(
      /larger than 64 KiB/,
    )
  })
})

describe('subsystem of a module', () => {
  const layout = parse({
    version: 1,
    sourceRoots: ['src', 'packages/app/src'],
    subsystems: [
      { name: 'ui', paths: ['src/renderer', 'src/preload/index.ts'] },
      { name: 'ui-model', paths: ['src/renderer/src/model'] },
    ],
  })

  it('defaults to the first directory under the source root', () => {
    const defaults = ARCHITECTURE_DEFAULT_LAYOUT
    expect(subsystemOf(defaults, 'src/main/ipc/a.ts')).toBe('src/main')
    expect(subsystemOf(defaults, 'src/index.ts')).toBe('src')
    expect(subsystemOf(defaults, 'test/a.test.ts')).toBe('test')
    expect(subsystemOf(defaults, 'app/core/engine.py')).toBe('app')
    expect(subsystemOf(defaults, 'setup.py')).toBe('(repository root)')
  })

  it('takes the most specific rule, then the most specific source root', () => {
    expect(subsystemOf(layout, 'src/renderer/src/App.tsx')).toBe('ui')
    expect(subsystemOf(layout, 'src/renderer/src/model/m.ts')).toBe('ui-model')
    expect(subsystemOf(layout, 'src/preload/index.ts')).toBe('ui')
    expect(subsystemOf(layout, 'src/preload/other.ts')).toBe('src/preload')
    expect(subsystemOf(layout, 'src/rendererx/a.ts')).toBe('src/rendererx')
    expect(subsystemOf(layout, 'packages/app/src/data/a.ts')).toBe(
      'packages/app/src/data',
    )
    expect(subsystemOf(layout, 'packages/lib/a.ts')).toBe('packages')
  })
})

describe('scan scope', () => {
  it('covers the whole repository by default and whole path segments otherwise', () => {
    expect(inLayoutScope(ARCHITECTURE_DEFAULT_LAYOUT, 'anything/a.ts')).toBe(true)
    const layout = parse({ version: 1, scope: ['src', 'tools/gen.ts'] })
    expect(inLayoutScope(layout, 'src/a.ts')).toBe(true)
    expect(inLayoutScope(layout, 'tools/gen.ts')).toBe(true)
    expect(inLayoutScope(layout, 'srcx/a.ts')).toBe(false)
    expect(inLayoutScope(layout, 'test/a.ts')).toBe(false)
  })
})
