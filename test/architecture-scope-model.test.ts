import { describe, expect, it } from 'vitest'
import {
  candidateLabel,
  scopeFromText,
  scopeText,
  toggleScopePath,
} from '../src/renderer/src/architecture-review/architecture-scope-model'

describe('architecture scope model', () => {
  it('reads one path per line, ignoring blank lines and surrounding spaces', () => {
    expect(scopeFromText(' src/web \n\n src/api\n')).toEqual({
      scope: ['src/web', 'src/api'],
    })
    expect(scopeFromText('   ')).toEqual({ scope: [] })
  })

  it('names the problem with a path the layout file would refuse', () => {
    expect(scopeFromText('src\n/abs').problem).toMatch(
      /"scope\[1\]" must be a relative path/,
    )
    expect(scopeFromText('src\nsrc').problem).toMatch(/repeats "src"/)
  })

  it('writes a scope back as text and toggles one path in or out', () => {
    expect(scopeText(['a', 'b'])).toBe('a\nb')
    expect(toggleScopePath('a\nb', 'c')).toBe('a\nb\nc')
    expect(toggleScopePath('a\nb\nc', 'b')).toBe('a\nc')
  })

  it('labels a candidate with its file count and, when known, its size', () => {
    expect(
      candidateLabel({ path: 'src/web', files: 2_100, bytes: 3.5 * 1024 * 1024 }),
    ).toBe('src/web · 2,100 files · 3.5 MiB')
    expect(candidateLabel({ path: 'top.ts', files: 1, bytes: null })).toBe(
      'top.ts · 1 file',
    )
  })
})
