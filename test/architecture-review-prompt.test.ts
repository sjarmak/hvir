import { expect, it } from 'vitest'
import { architectureReviewPrompt } from '../src/main/architecture-review/prompt'
import { localPath } from '../src/shared/host-path'
import type { ArchitectureCapture } from '../src/shared/architecture-review'
const capture: ArchitectureCapture = {
  root: localPath('/repo'),
  mode: 'head',
  baselineRevision: 'abc',
  currentRevision: 'live',
  fingerprint: 'fingerprint',
  capturedAt: 'now',
  exclusions: ['vendor'],
  before: [{ path: 'src/a.ts', content: 'export const a = 1' }],
  after: [{ path: 'src/a.ts', content: 'export const a = 2' }],
}
it('binds both captured sides, source coordinates and scope to the review instruction', () => {
  const prompt = architectureReviewPrompt(capture, 'snapshot', 'src/a.ts')
  expect(prompt).toContain('fingerprint')
  expect(prompt).toContain('snapshot')
  expect(prompt).toContain('before src/a.ts:1')
  expect(prompt).toContain('after src/a.ts:1')
  expect(prompt).toContain('export const a = 1')
  expect(prompt).toContain('export const a = 2')
  expect(prompt).toContain('interpretations')
})
it('refuses absent evidence and oversized prompts instead of truncating evidence', () => {
  expect(() => architectureReviewPrompt(capture, 'snapshot', 'other.ts')).toThrow(
    /evidence/,
  )
  expect(() =>
    architectureReviewPrompt(
      { ...capture, after: [{ path: 'src/a.ts', content: 'x'.repeat(40000) }] },
      'snapshot',
      'src/a.ts',
    ),
  ).toThrow(/large/)
})
