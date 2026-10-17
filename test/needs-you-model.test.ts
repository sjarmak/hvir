import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import type {
  BeadIssue,
  BeadsSnapshot,
  PullReviewer,
  PullSummary,
  PullsSnapshot,
} from '../src/shared'
import {
  needsYouBeads,
  needsYouPulls,
} from '../src/renderer/src/needs-you/needs-you-model'
import { needsYouRows } from '../src/renderer/src/needs-you/needs-you-rows'
import { asHostId, hostPath, type NeedsYouSourceSnapshot } from '../src/shared'

/** October 2026, local time: the 5th is a Monday, the 12th the Monday after. */
const october = (day: number, hour = 0): number => new Date(2026, 9, day, hour).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()
const NOW = october(12, 17)

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
  createdAt: iso(october(1, 9)),
  updatedAt: iso(october(2, 9)),
  checks: 'passing',
  review: 'none',
  openFeedback: 0,
  reviewers: [],
  ...extra,
})
const pending = (login: string, requestedAt: number): PullReviewer => ({
  login,
  kind: 'user',
  pending: true,
  requestedAt: iso(requestedAt),
})
const pulls = (extra: Partial<PullsSnapshot> = {}): PullsSnapshot => ({
  available: true,
  repo: 'org/repo',
  viewer: 'me',
  authored: [],
  reviewRequested: [],
  branchPulls: [],
  hasMore: false,
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
    const newer = source(
      '/new',
      2,
      pulls({
        repo: 'ORG/REPO',
        authored: [pull(1, { reviewers: [pending('them', october(8))] })],
      }),
    )
    expect(
      needsYouRows([], [older, newer], [], NOW).filter((row) => row.source === 'PR'),
    ).toEqual([])
  })

  it('keeps same-number PRs in different repositories and qualifies Bead identity by root', () =>
    hegel.test((tc) => {
      const number = tc.draw(gs.integers({ minValue: 1, maxValue: 100000 }))
      const sources = ['org/one', 'org/two'].map((repo, index) =>
        source(
          `/worktree-${index}`,
          1,
          pulls({ repo, reviewRequested: [pull(number, { author: 'them' })] }),
        ),
      )
      const rows = needsYouRows([], sources, [], NOW)
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

  it('lists asks and returned balls oldest first with business-time ages, appending open feedback', () => {
    const result = needsYouPulls(
      pulls({
        reviewRequested: [
          pull(2, {
            author: 'them',
            openFeedback: 3,
            reviewers: [pending('me', october(6, 10))],
          }),
          pull(6, { author: 'them', state: 'closed' }),
        ],
        authored: [
          pull(1, { reviewers: [pending('them', october(7, 9))] }),
          pull(3, {
            checks: 'failing',
            headCommittedAt: iso(october(8, 9)),
            openFeedback: 2,
          }),
          pull(4, { openFeedback: 1, reviewers: [pending('them', october(5, 9))] }),
          pull(5, { state: 'closed', checks: 'failing' }),
          pull(7, { draft: true }),
        ],
        branchPulls: [pull(8, { checks: 'failing' })],
      }),
      NOW,
    )
    expect(
      result.map((row) => [row.pull.number, row.reasons, row.since, row.age]),
    ).toEqual([
      [4, ['1 feedback item'], october(5, 9), '5d'],
      [2, ['Requested'], october(6, 10), '4d'],
      [3, ['CI failing', '2 feedback items'], october(8, 9), '2d'],
    ])
  })

  it('surfaces an own pull request nobody holds', () => {
    const result = needsYouPulls(
      pulls({ authored: [pull(9, { readyForReviewAt: iso(october(9, 17)) })] }),
      NOW,
    )
    expect(result.map((row) => [row.reasons, row.since, row.age])).toEqual([
      [['No reviewer yet'], october(9, 17), '1d'],
    ])
  })

  it('treats a PR repeated across both lists once, as authored', () =>
    hegel.test((tc) => {
      const number = tc.draw(gs.integers({ minValue: 1, maxValue: 100000 }))
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }))
      const repeated = Array.from({ length: count }, () =>
        pull(number, { checks: 'failing' }),
      )
      const result = needsYouPulls(
        pulls({ authored: repeated, reviewRequested: repeated }),
        NOW,
      )
      expect(result).toHaveLength(1)
      expect(result[0]?.pull.number).toBe(number)
      expect(result[0]?.reasons).toEqual(['CI failing'])
    }))

  it('keeps unavailable sources distinct from an empty actionable result at the consumer', () => {
    expect(
      needsYouBeads({ available: false, reason: 'error', message: 'offline' }),
    ).toEqual([])
    expect(
      needsYouPulls({ available: false, reason: 'error', message: 'offline' }, NOW),
    ).toEqual([])
  })
})
