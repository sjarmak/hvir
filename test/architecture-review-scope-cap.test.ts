import { describe, expect, it } from 'vitest'
import {
  ArchitectureScopeRefusalError,
  architectureScanOutcome,
  assertWithinScopeCap,
  liveBytesRefusal,
} from '../src/main/architecture-review/scope-cap'
import { ARCHITECTURE_SCOPE } from '../src/shared/architecture-review'

const cap = { maxFiles: 4, maxTotalBytes: 100 }
const files = (paths: readonly string[], size?: number) =>
  paths.map((path) => (size === undefined ? { path } : { path, size }))

function refusalOf(run: () => void) {
  try {
    run()
  } catch (error) {
    if (error instanceof ArchitectureScopeRefusalError) return error.refusal
    throw error
  }
  throw new Error('expected a refusal')
}

describe('architecture scope cap', () => {
  it('accepts a scope at the cap exactly', () => {
    expect(() =>
      assertWithinScopeCap(
        files(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 25),
        { end: 'main', scope: [] },
        cap,
      ),
    ).not.toThrow()
  })

  it('refuses one file over the cap, naming the counts and asking for a narrower scope', () => {
    const refusal = refusalOf(() =>
      assertWithinScopeCap(
        files(['src/a/1.ts', 'src/a/2.ts', 'src/b/1.ts', 'test/x.ts', 'top.ts'], 10),
        { end: 'main', scope: [] },
        cap,
      ),
    )
    expect(refusal).toMatchObject({
      end: 'main',
      scope: [],
      files: 5,
      bytes: 50,
      maxFiles: 4,
      maxBytes: 100,
    })
    expect(refusal.message).toBe(
      'Architecture scan refused: main has 5 files (50 bytes) in the whole repository, above the cap of 4 files and 100 bytes. Choose a narrower scope and scan again; the review never reads part of a scope.',
    )
    expect(refusal.candidates).toEqual([
      { path: 'src', files: 3, bytes: 30 },
      { path: 'test', files: 1, bytes: 10 },
      { path: 'top.ts', files: 1, bytes: 10 },
    ])
  })

  it('refuses on bytes alone and offers paths one level inside the measured scope', () => {
    const refusal = refusalOf(() =>
      assertWithinScopeCap(
        [
          { path: 'src/web/a.ts', size: 60 },
          { path: 'src/web/b.ts', size: 30 },
          { path: 'src/api/c.ts', size: 20 },
          { path: 'package.json', size: 5 },
        ],
        { end: 'working tree', scope: ['src'] },
        cap,
      ),
    )
    expect(refusal.files).toBe(4)
    expect(refusal.bytes).toBe(115)
    expect(refusal.message).toContain('in scope src')
    expect(refusal.candidates).toEqual([
      { path: 'src/web', files: 2, bytes: 90 },
      { path: 'src/api', files: 1, bytes: 20 },
    ])
  })

  it('refuses by file count before sizes are known and says the size is unmeasured', () => {
    const refusal = refusalOf(() =>
      assertWithinScopeCap(
        files(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']),
        { end: 'working tree', scope: [] },
        cap,
      ),
    )
    expect(refusal.bytes).toBeNull()
    expect(refusal.message).toContain('working tree has 5 files in the whole repository')
    expect(refusal.candidates.every((candidate) => candidate.bytes === null)).toBe(true)
  })

  it('names live bytes the host measured before any content was transferred', () => {
    const refusal = liveBytesRefusal(files(['a.ts', 'b.ts']), 17.5 * 1024 * 1024, {
      end: 'working tree',
      scope: ['a.ts', 'b.ts'],
    }).refusal
    expect(refusal.message).toBe(
      'Architecture scan refused: working tree has 2 files (17.5 MiB) in scope a.ts, b.ts, above the cap of 4,000 files and 16 MiB. Choose a narrower scope and scan again; the review never reads part of a scope.',
    )
    expect(refusal.maxBytes).toBe(ARCHITECTURE_SCOPE.maxTotalBytes)
  })

  it('turns a refusal into a result and lets every other failure through', async () => {
    const refusal = liveBytesRefusal([], 1, { end: 'main', scope: [] })
    await expect(architectureScanOutcome(Promise.reject(refusal))).resolves.toEqual({
      refused: refusal.refusal,
    })
    await expect(
      architectureScanOutcome(Promise.reject(new Error('other'))),
    ).rejects.toThrow('other')
  })
})
