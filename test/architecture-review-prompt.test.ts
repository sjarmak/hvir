import { expect, it } from 'vitest'
import { architectureReviewPrompt } from '../src/main/architecture-review/prompt'
import { localPath } from '../src/shared/host-path'
import type { ArchitectureCapture } from '../src/shared/architecture-review'
import { gitBlobId } from '../src/main/architecture-review/blob-id'

const source = (path: string, content: string) => ({
  path,
  content,
  object: gitBlobId(Buffer.from(content)),
})
const capture: ArchitectureCapture = {
  root: localPath('/repo'),
  baselineRef: 'HEAD',
  currentRef: 'working tree',
  baselineRevision: 'abc',
  currentRevision: 'live',
  fingerprint: 'fingerprint',
  capturedAt: 'now',
  exclusions: ['vendor'],
  before: [source('src/a.ts', 'export const a = 1')],
  after: [source('src/a.ts', 'export const a = 2')],
  configs: { before: [], after: [] },
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
  expect(prompt).toContain('"baseline":{"ref":"HEAD","revision":"abc"}')
  expect(prompt).toContain('"current":{"ref":"working tree","revision":"live"}')
})
it('refuses absent evidence and oversized prompts instead of truncating evidence', () => {
  expect(() => architectureReviewPrompt(capture, 'snapshot', 'other.ts')).toThrow(
    /evidence/,
  )
  expect(() =>
    architectureReviewPrompt(
      { ...capture, after: [source('src/a.ts', 'x'.repeat(40000))] },
      'snapshot',
      'src/a.ts',
    ),
  ).toThrow(/large/)
})
