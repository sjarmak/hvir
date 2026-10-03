import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'

import { preparePullFeedbackPreview } from '../src/renderer/src/github/pull-feedback-preview'
import type { PullDetail } from '../src/shared'

const detail: PullDetail = {
  available: true,
  repo: 'acme/widgets',
  number: 4,
  url: 'https://github.com/acme/widgets/pull/4',
  title: 'Panel',
  headOid: 'head-1',
  threadsPageComplete: true,
  payloadTruncated: false,
  threads: [
    {
      id: 'thread-1',
      body: 'Please revisit this',
      path: 'src/panel.ts',
      line: 8,
      isResolved: false,
      isOutdated: false,
      comments: [{ id: 'comment-1', body: 'Please revisit this', author: 'reviewer' }],
      commentsPageComplete: true,
    },
  ],
}

describe('preparePullFeedbackPreview', () => {
  it('produces exact inert text for selected threads', () => {
    const result = preparePullFeedbackPreview(detail, new Set(['thread-1']))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toContain('Untrusted hosted GitHub feedback')
      expect(result.text).toContain('Please revisit this')
    }
  })

  it('refuses empty and over-limit selections', () => {
    expect(preparePullFeedbackPreview(detail, new Set())).toMatchObject({ ok: false })
    const oversized: PullDetail = {
      ...detail,
      threads: [
        {
          id: 'thread-1',
          body: 'Please revisit this',
          path: 'src/panel.ts',
          line: 8,
          isResolved: false,
          isOutdated: false,
          reviewedCommitOid: 'head-1',
          comments: [{ id: 'large', body: 'x'.repeat(70_000) }],
          commentsPageComplete: true,
        },
      ],
    }
    expect(preparePullFeedbackPreview(oversized, new Set(['thread-1']))).toEqual({
      ok: false,
      reason: 'Selected feedback exceeds the 64 KiB preview limit.',
    })
  })

  it('preserves selected text and provenance without reordering or mutation', () =>
    hegel.test((tc) => {
      const bodies = tc.draw(
        gs.arrays(gs.text({ maxSize: 100 }), { minSize: 1, maxSize: 8 }),
      )
      const selectedIndex = tc.draw(
        gs.integers({ minValue: 0, maxValue: bodies.length - 1 }),
      )
      const threads = bodies.map((body, index) => ({
        ...detail.threads[0]!,
        id: `thread-${index}`,
        reviewedCommitOid: 'reviewed-commit',
        comments: [
          {
            id: `comment-${index}`,
            body,
            author: 'reviewer',
            createdAt: '2026-10-02T00:00:00Z',
          },
        ],
      }))
      const input = { ...detail, threads }
      const before = JSON.stringify(input)
      const ids = new Set([`thread-${selectedIndex}`, 'absent-thread'])
      const result = preparePullFeedbackPreview(input, ids)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.reason)
      expect(result.text).toContain(
        `comment-${selectedIndex} · @reviewer · 2026-10-02T00:00:00Z: ${bodies[selectedIndex]}`,
      )
      expect(result.text).toContain(`Source: ${detail.url}`)
      expect(result.text).toContain(`Current head: ${detail.headOid}`)
      expect(result.text).toContain('reviewed commit reviewed-commit')
      expect(result).toEqual(
        preparePullFeedbackPreview(input, new Set([...ids].reverse())),
      )
      expect(JSON.stringify(input)).toBe(before)
      expect([...ids]).toEqual([`thread-${selectedIndex}`, 'absent-thread'])
    }))

  it('discloses selected incomplete replies and exact byte-size boundaries', () => {
    const input = {
      ...detail,
      threads: [{ ...detail.threads[0]!, commentsPageComplete: false }],
    }
    const selected = new Set(['thread-1'])
    const preview = preparePullFeedbackPreview(input, selected)
    expect(preview.ok && preview.text).toContain('[Replies incomplete or truncated]')
    const empty = {
      ...detail,
      threads: [{ ...detail.threads[0]!, comments: [{ id: 'c', body: '' }] }],
    }
    const base = preparePullFeedbackPreview(empty, selected)
    if (!base.ok) throw new Error(base.reason)
    const remaining = 64 * 1024 - new TextEncoder().encode(base.text).length
    const withBody = (body: string): PullDetail => ({
      ...empty,
      threads: [{ ...empty.threads[0]!, comments: [{ id: 'c', body }] }],
    })
    expect(preparePullFeedbackPreview(withBody('x'.repeat(remaining)), selected).ok).toBe(
      true,
    )
    expect(
      preparePullFeedbackPreview(withBody('x'.repeat(remaining) + 'é'), selected).ok,
    ).toBe(false)
  })

  it('preserves unknown optional provenance and top-level incompleteness', () => {
    const input: PullDetail = {
      ...detail,
      headOid: undefined,
      threadsPageComplete: false,
      payloadTruncated: true,
      threads: [
        {
          ...detail.threads[0]!,
          path: undefined,
          line: undefined,
          reviewedCommitOid: undefined,
          isResolved: true,
          isOutdated: true,
          comments: [
            {
              id: 'comment-unknown',
              body: 'body',
              author: undefined,
              createdAt: undefined,
            },
          ],
        },
      ],
    }
    const result = preparePullFeedbackPreview(input, new Set(['thread-1']))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toContain('Current head: unknown')
      expect(result.text).toContain('location unknown')
      expect(result.text).toContain('resolved, outdated')
      expect(result.text).toContain('reviewed commit unknown')
      expect(result.text).toContain('unknown author · unknown timestamp')
      expect(result.text).toContain('[Hosted feedback is incomplete or truncated]')
    }
  })
})
