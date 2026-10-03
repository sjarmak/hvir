import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import { beadEvalLink } from '../src/renderer/src/beads/bead-eval-links'

const runUrl = 'https://example.omniapp.co/ai-hub/eval-runs/run-123'

describe('producer-supplied evaluation links', () => {
  it('leaves beads without evaluation metadata unchanged', () => {
    expect(beadEvalLink(undefined)).toEqual({ kind: 'absent' })
    expect(beadEvalLink({ 'gc.rig': 'omni' })).toEqual({ kind: 'absent' })
  })

  it('preserves the exact run URL and separately labels supplied facts', () => {
    expect(
      beadEvalLink({
        'eval.run_url': runUrl,
        'eval.run_id': 'run-123',
        'eval.candidate_sha': 'a'.repeat(40),
        'eval.baseline_sha': 'b'.repeat(40),
        'eval.model': 'model-v1',
        'eval.config': 'prompt-set-v2',
        'eval.recorded_at': '2026-10-02T12:00:00Z',
      }),
    ).toEqual({
      kind: 'available',
      url: runUrl,
      origin: 'https://example.omniapp.co',
      facts: [
        { label: 'Run ID', value: 'run-123' },
        { label: 'Candidate commit', value: 'a'.repeat(40) },
        { label: 'Baseline commit', value: 'b'.repeat(40) },
        { label: 'Model', value: 'model-v1' },
        { label: 'Config', value: 'prompt-set-v2' },
        { label: 'Recorded at', value: '2026-10-02T12:00:00Z' },
      ],
      invalidFields: [],
    })
  })

  it.each([
    '',
    'not a URL',
    'http://example.com/run',
    'javascript:alert(1)',
    'file:///private/result.json',
    'https://user:password@example.com/run',
    'https://example.com/\nrun',
    ' https://example.com/run',
    'https://example.com/\\run',
    'https://example.com/%0arun',
    `https://example.com/${'a'.repeat(2048)}`,
  ])('refuses unsafe or malformed destinations: %j', (url) => {
    expect(beadEvalLink({ 'eval.run_url': url }).kind).toBe('invalid')
  })

  it('reports orphaned and invalid facts without inventing identity', () => {
    expect(beadEvalLink({ 'eval.run_id': 'run-123' }).kind).toBe('invalid')
    expect(
      beadEvalLink({
        'eval.run_url': runUrl,
        'eval.model': 'x'.repeat(257),
        'eval.config': '\u001b[31munsafe',
        'eval.candidate_sha': 'not a commit',
        'eval.recorded_at': 'yesterday',
      }),
    ).toMatchObject({
      kind: 'available',
      facts: [],
      invalidFields: ['Candidate commit', 'Model', 'Config', 'Recorded at'],
    })
  })

  it('accepts exact bounds and both full Git object ID formats', () => {
    const prefix = 'https://results.example/'
    const url = prefix + 'x'.repeat(2048 - prefix.length)
    expect(
      beadEvalLink({
        'eval.run_url': url,
        'eval.run_id': 'x'.repeat(256),
        'eval.candidate_sha': 'a'.repeat(64),
        'eval.baseline_sha': 'B'.repeat(40),
        'eval.recorded_at': '2024-02-29T12:00:00.123Z',
      }),
    ).toMatchObject({ kind: 'available', url, invalidFields: [] })
    expect(beadEvalLink({ 'eval.run_url': `${url}x` }).kind).toBe('invalid')
  })

  it.each([
    '2026-02-29T12:00:00Z',
    '2026-10-02T24:00:00Z',
    '2026-10-02T12:00:00+00:00',
    '2026-10-02',
  ])('refuses noncanonical or impossible producer timestamps: %s', (recordedAt) => {
    expect(
      beadEvalLink({ 'eval.run_url': runUrl, 'eval.recorded_at': recordedAt }),
    ).toMatchObject({ kind: 'available', facts: [], invalidFields: ['Recorded at'] })
  })

  it.each(['https://example.com/%', 'https://example.com/%E2%80%AEhidden'])(
    'refuses malformed encodings and encoded display controls: %s',
    (url) => {
      expect(beadEvalLink({ 'eval.run_url': url }).kind).toBe('invalid')
    },
  )

  it('accepts only bounded credential-free HTTPS destinations for arbitrary input', () =>
    hegel.test((tc) => {
      const raw = tc.draw(gs.text({ maxSize: 2100 }))
      const result = beadEvalLink({ 'eval.run_url': raw })
      if (result.kind !== 'available') return
      const parsed = new URL(result.url)
      expect(result.url).toBe(raw)
      expect(parsed.protocol).toBe('https:')
      expect(parsed.username + parsed.password).toBe('')
      expect(result.url.length).toBeLessThanOrEqual(2048)
    }))

  it('keeps supplied run identity unchanged across valid generated links', () =>
    hegel.test((tc) => {
      const id = tc.draw(gs.integers({ minValue: 1, maxValue: 1000000 }))
      const url = `https://results.example/run/${id}?compare=baseline#result`
      expect(
        beadEvalLink({ 'eval.run_url': url, 'eval.run_id': String(id) }),
      ).toMatchObject({
        kind: 'available',
        url,
        facts: [{ label: 'Run ID', value: String(id) }],
      })
    }))
})
