import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'

import {
  beadNeedsHuman,
  isAnsweredAsk,
  isOpenLabelledAsk,
  type BeadIssue,
} from '../src/shared'

const bead = (extra: Partial<BeadIssue> = {}): BeadIssue => ({
  id: 'dec-1',
  title: 'Choose',
  status: 'open',
  priority: 2,
  issueType: 'task',
  labels: [],
  dependencyCount: 0,
  dependentCount: 0,
  ...extra,
})

describe('human ask rule', () => {
  it('treats an open needs/stephanie bead of any work type as an ask until it is answered', () => {
    const ask = bead({ labels: ['needs/stephanie'] })
    const answered = bead({
      labels: ['needs/stephanie'],
      metadata: { 'gc.answered': '2026-09-27' },
    })
    expect(beadNeedsHuman(ask)).toBe(true)
    expect(isOpenLabelledAsk(ask)).toBe(true)
    expect(isAnsweredAsk(ask)).toBe(false)
    expect(beadNeedsHuman(answered)).toBe(false)
    expect(isOpenLabelledAsk(answered)).toBe(false)
    expect(isAnsweredAsk(answered)).toBe(true)
  })

  it('keeps the decision-type and needs-human rules and ignores closed or unlabelled work', () => {
    expect(beadNeedsHuman(bead({ issueType: 'decision' }))).toBe(true)
    expect(beadNeedsHuman(bead({ labels: ['Needs-Human'] }))).toBe(true)
    expect(beadNeedsHuman(bead())).toBe(false)
    expect(beadNeedsHuman(bead({ status: 'closed', labels: ['needs/stephanie'] }))).toBe(
      false,
    )
    expect(beadNeedsHuman(bead({ issueType: 'convoy', labels: ['needs-human'] }))).toBe(
      false,
    )
  })

  it('applies the queue rule to labelled open beads only', () => {
    expect(isOpenLabelledAsk(bead({ issueType: 'decision' }))).toBe(false)
    expect(
      isOpenLabelledAsk(bead({ status: 'blocked', labels: ['needs/stephanie'] })),
    ).toBe(false)
  })

  it('never reports one bead as both awaiting and answered', () =>
    hegel.test((tc) => {
      const issue = bead({
        status: tc.draw(gs.sampledFrom(['open', 'in_progress', 'blocked', 'closed'])),
        issueType: tc.draw(gs.sampledFrom(['task', 'bug', 'decision', 'epic', 'convoy'])),
        labels: tc.draw(
          gs.arrays(gs.sampledFrom(['needs/stephanie', 'needs-human', 'other']), {
            maxSize: 3,
          }),
        ),
        metadata: { 'gc.answered': tc.draw(gs.sampledFrom(['', '2026-10-02'])) },
      })
      const labelledHuman = issue.labels.includes('needs-human')
      if (!labelledHuman) {
        expect(beadNeedsHuman(issue) && isAnsweredAsk(issue)).toBe(false)
      }
      if (isOpenLabelledAsk(issue) && issue.issueType !== 'convoy') {
        expect(beadNeedsHuman(issue)).toBe(true)
      }
    }))
})
