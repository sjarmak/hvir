import { createHash } from 'node:crypto'
import type { ArchitectureHandoffPlan } from '../../shared/architecture-handoff'
import type {
  ArchitectureCapture,
  ArchitectureReviewSnapshot,
} from '../../shared/architecture-review'
import type { HvirWorktreeTarget } from '../git/hvir-worktrees'
import { hostPath } from '../../shared/host-path'
import {
  architectureExplanationPrompt,
  architectureHandoffBrief,
  architectureHandoffPrompt,
} from './handoff-brief'

/** Everything a prepared handoff pins: the exact worktree, brief and prompt it will use. */
export interface PlannedHandoff {
  readonly kind: 'review' | 'explanation'
  readonly snapshotId: string
  /** The evidence path the launch was prepared from. */
  readonly path?: string
  readonly slug: string
  readonly body: string
  readonly digest: string
  readonly plan: ArchitectureHandoffPlan
}

export interface HandoffPlanInput {
  readonly capture: ArchitectureCapture
  readonly snapshot: ArchitectureReviewSnapshot
  /** The evidence path, relative to the capture root. */
  readonly focus: string
  readonly slug: string
  /** The Current commit the worktree starts at. */
  readonly commit: string
  readonly target: HvirWorktreeTarget
}

export function planArchitectureHandoff(input: HandoffPlanInput): PlannedHandoff {
  return plan(input, 'review')
}

export function planArchitectureExplanation(
  input: Omit<HandoffPlanInput, 'focus'>,
): PlannedHandoff {
  return plan({ ...input, focus: '' }, 'explanation')
}

function plan(input: HandoffPlanInput, kind: PlannedHandoff['kind']): PlannedHandoff {
  const { capture, snapshot, target, commit } = input
  if (target.commit !== commit) throw new Error('Handoff worktree target changed commit')
  const worktree = hostPath(capture.root.hostId, target.path)
  const briefInput = {
    snapshotId: snapshot.id,
    root: capture.root,
    focus: input.focus,
    baselineRef: capture.baselineRef,
    baselineRevision: capture.baselineRevision,
    currentRef: capture.currentRef,
    currentRevision: commit,
    scope:
      capture.layout.scope.length > 0 ? capture.layout.scope.join(', ') : 'repository',
    plan: { branch: target.branch, worktree, commit },
    modules: snapshot.analysis.modules,
    relationships: snapshot.analysis.relationships,
  }
  const plan: ArchitectureHandoffPlan = {
    branch: target.branch,
    worktree,
    commit,
    brief: architectureHandoffBrief(briefInput),
  }
  const body =
    kind === 'review'
      ? architectureHandoffPrompt(briefInput)
      : architectureExplanationPrompt(briefInput)
  return {
    kind,
    snapshotId: snapshot.id,
    path: kind === 'review' ? input.focus : undefined,
    slug: input.slug,
    body,
    digest: handoffDigest(body, plan),
    plan,
  }
}

/** One digest over everything the preview showed, so an approved preview is exact. */
export function handoffDigest(body: string, plan: ArchitectureHandoffPlan): string {
  return createHash('sha256').update(JSON.stringify({ body, plan })).digest('hex')
}
