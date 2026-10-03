import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import type { BeadIssue, BeadsSnapshot, PullSummary, PullsSnapshot } from '../src/shared'
import {
  needsYouBeads,
  needsYouPulls,
} from '../src/renderer/src/needs-you/needs-you-model'
import { needsYouRows } from '../src/renderer/src/needs-you/needs-you-rows'
import { asHostId, hostPath, type NeedsYouSourceSnapshot } from '../src/shared'

const bead = (id: string, extra: Partial<BeadIssue> = {}): BeadIssue => ({
  id,
  title: id,
  status: 'open',
  priority: 2,
  issueType: 'task',
  labels: [],
  dependencyCount: 0,
  dependentCount: 0,
  ...extra,
})
const beads = (issues: readonly BeadIssue[]): BeadsSnapshot => ({
  available: true,
  issues,
  readyIds: [],
  dispatchableIds: [],
  dispatchabilitySource: 'structural',
  dependencies: [],
  gates: [],
})
const pull = (number: number, extra: Partial<PullSummary> = {}): PullSummary => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/org/repo/pull/${number}`,
  state: 'open',
  draft: false,
  headRef: 'feature',
  author: 'me',
  updatedAt: '2026-10-02',
  checks: 'passing',
  review: 'none',
  openFeedback: 0,
  ...extra,
})
const pulls = (extra: Partial<PullsSnapshot> = {}): PullsSnapshot => ({
  available: true,
  repo: 'org/repo',
  viewer: 'me',
  authored: [],
  reviewRequested: [],
  branchPulls: [],
  ...extra,
})
const source = (
  path: string,
  observedAt: number,
  response: PullsSnapshot,
): NeedsYouSourceSnapshot => ({
  projectId: path,
  workspaceId: path,
  projectName: path,
  workspaceName: path,
  root: hostPath(asHostId('local'), path),
  hostId: 'local',
  beads: { observedAt, response: beads([bead('same-id', { issueType: 'decision' })]) },
  pulls: { observedAt, response },
})

describe('Needs you source policy', () => {
  it('uses the latest available repository read instead of retaining an older actionable PR', () => {
    const older = source('/old', 1, pulls({ authored: [pull(1, { checks: 'failing' })] }))
    const newer = source('/new', 2, pulls({ repo: 'ORG/REPO', authored: [pull(1)] }))
    expect(needsYouRows([], [older, newer]).filter((row) => row.source === 'PR')).toEqual(
      [],
    )
  })

  it('keeps same-number PRs in different repositories and qualifies Bead identity by root', () =>
    hegel.test((tc) => {
      const number = tc.draw(gs.integers({ minValue: 1, maxValue: 100000 }))
      const sources = ['org/one', 'org/two'].map((repo, index) =>
        source(`/worktree-${index}`, 1, pulls({ repo, reviewRequested: [pull(number)] })),
      )
      const rows = needsYouRows([], sources)
      expect(rows.filter((row) => row.source === 'PR')).toHaveLength(2)
      expect(rows.filter((row) => row.source === 'Bead')).toHaveLength(2)
      expect(new Set(rows.map((row) => row.key)).size).toBe(4)
    }))

  it('reuses human classification without treating prose or answered/closed decisions as work', () => {
    expect(
      needsYouBeads(
        beads([
          bead('labelled', { labels: ['needs-human'] }),
          bead('decision', { issueType: 'decision' }),
          bead('answered', { issueType: 'decision', metadata: { 'gc.answered': 'yes' } }),
          bead('closed', { status: 'closed', labels: ['needs-human'] }),
          bead('prose', { title: 'Urgent: needs human decision!' }),
        ]),
      )
        .map((row) => row.id)
        .sort(),
    ).toEqual(['decision', 'labelled'])
  })

  it('combines review requests, failed checks and feedback without including quiet or closed PRs', () => {
    const result = needsYouPulls(
      pulls({
        reviewRequested: [pull(2), pull(4, { state: 'closed' })],
        authored: [
          pull(1),
          pull(2, { checks: 'failing', openFeedback: 2 }),
          pull(3, { openFeedback: 1 }),
        ],
        branchPulls: [pull(5, { checks: 'failing' })],
      }),
    )
    expect(result.map((row) => row.pull.number)).toEqual([2, 3])
    expect(result[0]?.reasons).toEqual([
      'Review requested',
      'CI failing',
      '2 feedback items',
    ])
    expect(result[1]?.reasons).toEqual(['1 feedback item'])
  })

  it('deduplicates a PR regardless of repeated source membership', () =>
    hegel.test((tc) => {
      const number = tc.draw(gs.integers({ minValue: 1, maxValue: 100000 }))
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }))
      const repeated = Array.from({ length: count }, () =>
        pull(number, { checks: 'failing' }),
      )
      const result = needsYouPulls(
        pulls({ authored: repeated, reviewRequested: repeated }),
      )
      expect(result).toHaveLength(1)
      expect(result[0]?.pull.number).toBe(number)
      expect(result[0]?.reasons).toEqual(['Review requested', 'CI failing'])
    }))

  it('keeps unavailable sources distinct from an empty actionable result at the consumer', () => {
    expect(
      needsYouBeads({ available: false, reason: 'error', message: 'offline' }),
    ).toEqual([])
    expect(
      needsYouPulls({ available: false, reason: 'error', message: 'offline' }),
    ).toEqual([])
  })
})
