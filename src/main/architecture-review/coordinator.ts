import { randomUUID } from 'node:crypto'
import {
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../shared/host-path'
import type {
  ArchitectureScopeRecord,
  ArchitectureScopeRequest,
} from '../../shared/architecture-scope'
import { measureTextWorkload } from '../../shared/viewer-workload-policy'
import type { ArchitectureAnalysis } from '../../shared/architecture-analysis'
import type {
  ArchitectureCapture,
  ArchitectureCommitRange,
  ArchitectureCommitRangeRequest,
  ArchitectureCommitClassifyResult,
  ArchitectureCommitClassifyRequest,
  ArchitectureEvidence,
  ArchitecturePreparedReview,
  ArchitectureReviewLaunch,
  ArchitectureEvidenceRequest,
  ArchitectureReviewKey,
  ArchitectureReviewRequest,
  ArchitectureReviewSnapshot,
  ArchitectureExplanationRequest,
  ArchitectureExplainRequest,
} from '../../shared/architecture-review'
import {
  ArchitectureExplanationError,
  checkArchitectureExplanation,
  parseArchitectureExplanation,
  type ArchitectureExplanationState,
} from '../../shared/architecture-explanation'
import type {
  ArchitectureAgentLaunch,
  ArchitectureHandoff,
} from '../../shared/architecture-handoff'
import {
  ARCHITECTURE_LIVE_REVISION,
  ARCHITECTURE_SCOPE,
} from '../../shared/architecture-review'
import type { AddedWorktree } from '../git/mutation-coordinator'
import type { ProjectHost } from '../project-host/project-host'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import { captureArchitecture, validateArchitectureRequest } from './capture'
import { affectsArchitectureCapture } from './capture-entries'
import { listArchitectureCommits } from './commit-range'
import {
  ArchitectureCommitClassifier,
  type ModuleImportsPort,
  type PairScanPort,
} from './commit-classifier'
import { hasLiveCurrent } from './ends'
import { readArchitectureLiveBase, readArchitectureLiveState } from './freshness'
import { ArchitectureScanRecorder } from './scan-recorder'
import { architectureAnalysisCache, architectureBlobCache } from './scan-caches'
import {
  ArchitectureLaunches,
  handoffCommit,
  writeArchitectureBrief,
  type ArchitectureWorktreePort,
} from './handoff'
import { planArchitectureHandoff, type PlannedHandoff } from './handoff-plan'
import { ArchitectureScopeRefusalError } from './scope-cap'
import { recordArchitectureScope } from './scope-record'
import { architectureExplanationPrompt } from './handoff-brief'
import type { ArchitectureExplanationModelPort } from './explanation-model'
import { readArchitectureExplanationContext } from './explanation-context'

const MAX_REVIEWS = 4
const STRIP_TIMEOUT = 60_000
const LIVE_SETTLE_MS = 2_000
export interface ArchitectureReviewPorts {
  readonly resources: RendererResourceScopes
  readonly capture?: typeof captureArchitecture
  readonly liveState?: typeof readArchitectureLiveState
  readonly commits?: typeof listArchitectureCommits
  readonly imports?: ModuleImportsPort
  readonly explanationModel?: ArchitectureExplanationModelPort
  readonly explanationContext?: typeof readArchitectureExplanationContext
  /** Worktree creation and brief writing for the agent handoff (ADR-963). */
  readonly handoff?: {
    readonly worktrees: ArchitectureWorktreePort
    readonly liveBase?: typeof readArchitectureLiveBase
    readonly writeBrief?: typeof writeArchitectureBrief
  }
  readonly analyze: (
    capture: ArchitectureCapture,
    signal: AbortSignal,
    recorder: ArchitectureScanRecorder,
  ) => Promise<ArchitectureAnalysis>
}
interface Review {
  readonly controller: AbortController
  readonly host: ProjectHost
  readonly request: ArchitectureReviewRequest
  readonly lease: RendererResourceLease
  readonly stopConnection?: () => void | Promise<void>
  readonly capture?: ArchitectureCapture
  /** Live state read before capture; absent when both ends are commits. */
  readonly liveState?: string
  /** The approved-on-preview handoff; consumed by the one handoff it allows. */
  readonly plan?: PlannedHandoff
  /** A handoff whose worktree exists but whose brief or launch did not finish. */
  readonly unfinished?: UnfinishedHandoff
  readonly snapshot?: ArchitectureReviewSnapshot
}
interface UnfinishedHandoff {
  readonly planned: PlannedHandoff
  readonly added: AddedWorktree
  readonly briefWritten: boolean
}
interface Follower {
  readonly host: ProjectHost
  readonly stop: () => void | Promise<void>
  timer?: ReturnType<typeof setTimeout>
}
/** Workspace leases own bounded captured pairs; analysis owns no host authority. */
export class ArchitectureReviewCoordinator {
  private readonly reviews = new Map<string, Review>()
  private readonly followers = new Map<string, Follower>()
  private readonly explanations = new Map<string, ArchitectureExplanationState>()
  private readonly launches = new ArchitectureLaunches()
  private readonly blobs = architectureBlobCache()
  private readonly analyses = architectureAnalysisCache()
  private readonly classifier: ArchitectureCommitClassifier | undefined
  constructor(private readonly ports: ArchitectureReviewPorts) {
    this.classifier = ports.imports
      ? new ArchitectureCommitClassifier({
          imports: ports.imports,
          scan: this.scanPair,
          blobs: this.blobs,
        })
      : undefined
  }

  private readonly scanPair: PairScanPort = async (host, request, signal) => {
    const recorder = new ArchitectureScanRecorder()
    try {
      const capture = await (this.ports.capture ?? captureArchitecture)(
        host,
        request,
        signal,
        recorder,
        this.blobs,
      )
      return await this.ports.analyze(capture, signal, recorder)
    } catch (error) {
      if (error instanceof ArchitectureScopeRefusalError) return undefined
      throw error
    }
  }

  async scan(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureReviewRequest,
  ): Promise<ArchitectureReviewSnapshot> {
    this.ports.resources.assertCurrent(owner)
    const key = reviewKey(owner, request)
    this.closeReview(owner, request, true)
    if (this.reviews.size >= MAX_REVIEWS)
      throw new Error('Close an architecture review before opening another')
    const controller = new AbortController()
    const lease = this.ports.resources.register(
      owner,
      {
        lifetime: 'workspace',
        type: 'architecture-review',
        root: request.root,
        id: request.reviewId,
      },
      () => this.close(owner, request),
    )
    this.reviews.set(key, { controller, host, request, lease })
    try {
      const stopConnection = host.onConnectionState((state) => {
        if (state !== 'connected') this.close(owner, request)
      })
      const review: Review = { controller, host, request, lease, stopConnection }
      if (controller.signal.aborted) {
        await stopConnection()
        controller.signal.throwIfAborted()
      }
      this.reviews.set(key, review)
      const recorder = new ArchitectureScanRecorder()
      const { capture, liveState } = await this.capture(
        host,
        request,
        controller.signal,
        recorder,
      )
      this.assertLive(owner, key, controller)
      const analysis =
        this.analyses.lookup(capture.fingerprint) ??
        (await this.ports.analyze(capture, controller.signal, recorder))
      this.assertLive(owner, key, controller)
      const { before: _before, after: _after, configs: _configs, ...metadata } = capture
      const payload = { ...metadata, id: randomUUID(), analysis }
      // The renderer receives this payload over IPC; its serialized size is the transfer cost.
      const payloadBytes = recorder.measureSync(
        'renderer-payload',
        () => Buffer.byteLength(JSON.stringify(payload)),
        (bytes) => ({ bytes, items: 1 }),
      )
      this.analyses.store(capture.fingerprint, analysis, payloadBytes)
      const snapshot: ArchitectureReviewSnapshot = {
        ...payload,
        metrics: recorder.metrics(),
      }
      this.reviews.set(key, { ...review, capture, liveState, snapshot })
      return snapshot
    } catch (error) {
      if (this.reviews.get(key)?.controller === controller) this.close(owner, request)
      throw error
    }
  }

  follow(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureReviewKey,
    publish: () => void,
  ): void {
    this.ports.resources.assertCurrent(owner)
    const key = reviewKey(owner, request)
    const review = this.reviews.get(key)
    if (!review || review.host !== host || !hasLiveCurrent(review.request))
      throw new Error('A live architecture snapshot is required before following')
    if (this.followers.get(key)?.host === host) return
    this.stopFollower(key)
    const follower: Follower = {
      host,
      stop: host.watch(
        request.root,
        (event) => {
          const changedPath = relativeArchitecturePath(request.root, event.path)
          if (!changedPath || !affectsArchitectureCapture(changedPath)) return
          if (follower.timer) clearTimeout(follower.timer)
          follower.timer = setTimeout(() => {
            follower.timer = undefined
            if (this.followers.get(key) === follower) publish()
          }, LIVE_SETTLE_MS)
        },
        {
          recursive: true,
          excludeDirectoryNames: ARCHITECTURE_SCOPE.excludedDirectories,
          onError: (error) => {
            this.stopFollower(key)
            console.error('[architecture-review] live watch failed', error)
          },
        },
      ),
    }
    this.followers.set(key, follower)
  }

  pause(owner: RendererOwner, request: ArchitectureReviewKey): void {
    this.ports.resources.assertCurrent(owner)
    this.stopFollower(reviewKey(owner, request))
  }

  /**
   * Records the reviewer's scope in the working tree's layout file. `file` is that file's
   * path, authorized inside the workspace; the next scan reads it like any other edit.
   */
  async recordScope(
    owner: RendererOwner,
    host: ProjectHost,
    file: HostPath,
    request: ArchitectureScopeRequest,
  ): Promise<ArchitectureScopeRecord> {
    this.ports.resources.assertCurrent(owner)
    const record = await recordArchitectureScope(host, file, request.scope)
    this.ports.resources.assertCurrent(owner)
    return record
  }

  /** The commit strip needs no review lease: it pins nothing and holds no capture. */
  async commits(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureCommitRangeRequest,
  ): Promise<ArchitectureCommitRange> {
    this.ports.resources.assertCurrent(owner)
    const range = await (this.ports.commits ?? listArchitectureCommits)(
      host,
      request,
      AbortSignal.timeout(STRIP_TIMEOUT),
    )
    this.ports.resources.assertCurrent(owner)
    return range
  }

  async classify(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureCommitClassifyRequest,
  ): Promise<ArchitectureCommitClassifyResult> {
    this.ports.resources.assertCurrent(owner)
    if (!this.classifier) throw new Error('Commit classification is unavailable')
    const result = await this.classifier.classify(
      host,
      request,
      AbortSignal.timeout(STRIP_TIMEOUT),
    )
    this.ports.resources.assertCurrent(owner)
    return result
  }

  async evidence(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureEvidenceRequest,
  ): Promise<ArchitectureEvidence> {
    const key = reviewKey(owner, request)
    const review = this.reviews.get(key)
    if (
      !review?.capture ||
      !review.snapshot ||
      review.snapshot.id !== request.snapshotId ||
      review.host !== host
    ) {
      throw new Error('Architecture evidence is unavailable; refresh the review')
    }
    this.assertLive(owner, key, review.controller)
    const capture = review.capture
    const source = [...capture.before, ...capture.after].find((file) =>
      hostPathEquals(joinHostPath(capture.root, file.path), request.path),
    )
    if (!source) throw new Error('Path is not evidence in this architecture snapshot')
    const stale = request.capturedOnly === true ? null : await this.isStale(review)
    this.assertLive(owner, key, review.controller)
    return {
      snapshotId: review.snapshot.id,
      stale,
      diff: {
        path: request.path,
        ...evidenceBase(capture),
        baseLabel: endLabel(capture.baselineRef, capture.baselineRevision),
        currentLabel: endLabel(capture.currentRef, capture.currentRevision),
        baseInput: measureTextWorkload(
          capture.before.find((file) => file.path === source.path)?.content ?? '',
        ),
        currentInput: measureTextWorkload(
          capture.after.find((file) => file.path === source.path)?.content ?? '',
        ),
      },
    }
  }

  /**
   * Pins the exact handoff the person approves: the worktree, branch and starting commit,
   * the brief and the prompt. Nothing is created until `handoff` presents the digest.
   */
  async prepare(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureEvidenceRequest,
  ): Promise<ArchitecturePreparedReview> {
    const worktrees = this.worktrees()
    const { key, commit } = await this.freshHandoffBase(owner, host, request)
    const review = this.reviews.get(key)!
    if (review.unfinished) return this.reoffer(key, request, review.unfinished.planned)
    const capture = review.capture!
    const focus = [...capture.before, ...capture.after].find((file) =>
      hostPathEquals(joinHostPath(request.root, file.path), request.path),
    )!.path
    const slug = `review-${randomUUID().slice(0, 8)}`
    const planned = planArchitectureHandoff({
      capture,
      snapshot: review.snapshot!,
      focus,
      slug,
      commit,
      target: worktrees.worktreeTarget(request.root, slug, commit),
    })
    return this.reoffer(key, request, planned)
  }

  /**
   * Creates the prepared worktree once, writes the brief and issues the one launch the
   * agent session may spend. The plan is consumed before any mutation; a handoff that
   * fails after its worktree exists is kept so preparing again finishes it there. Main
   * holds the worktree in flight from before its creation (or the retry) until the brief
   * write settles, so no removal lands in between.
   */
  async handoff(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureReviewLaunch,
  ): Promise<ArchitectureHandoff> {
    const worktrees = this.worktrees()
    const planned = this.reviews.get(reviewKey(owner, request))?.plan
    if (!planned || !matchesPlan(planned, request))
      throw new Error('Architecture review preview changed; prepare again')
    const { key, commit } = await this.freshHandoffBase(owner, host, request)
    // Read and spend in one synchronous step: a concurrent handoff finds the plan gone.
    const review = this.reviews.get(key)
    if (!review || review.plan !== planned || commit !== planned.plan.commit)
      throw new Error('Architecture review preview changed; prepare again')
    const resumed = review.unfinished?.planned === planned ? review.unfinished : undefined
    this.reviews.set(key, { ...review, plan: undefined, unfinished: undefined })
    const held = resumed
      ? await worktrees.holdWorktree(resumed.added)
      : await worktrees.addWorktree(request.root, planned.slug, commit)
    try {
      const step = resumed ?? { planned, added: held.added, briefWritten: false }
      if (!hostPathEquals(step.added.root, planned.plan.worktree))
        throw new Error('Git created the handoff worktree somewhere else')
      return await this.finishHandoff(owner, host, key, review.controller, step)
    } finally {
      held.release()
    }
  }

  async explain(
    owner: RendererOwner,
    host: ProjectHost,
    projectRoot: HostPath,
    request: ArchitectureExplainRequest,
    publish: (
      state: Extract<ArchitectureExplanationState, { status: 'waiting' }>,
    ) => void = () => undefined,
  ): Promise<ArchitectureExplanationState> {
    const model = this.ports.explanationModel
    if (!model) throw new Error('Architecture explanation is unavailable in this window')
    const { key, review } = this.currentSnapshot(owner, host, request)
    const capture = review.capture!
    const snapshot = review.snapshot!
    const explanationContext = await (
      this.ports.explanationContext ?? readArchitectureExplanationContext
    )(
      host,
      {
        root: capture.root,
        baselineRevision: capture.baselineRevision,
        currentRevision: capture.currentRevision,
        scope: capture.layout.scope,
      },
      review.controller.signal,
    )
    const prompt = architectureExplanationPrompt({
      snapshotId: snapshot.id,
      root: capture.root,
      baselineRef: capture.baselineRef,
      baselineRevision: capture.baselineRevision,
      currentRef: capture.currentRef,
      currentRevision: capture.currentRevision,
      scope:
        capture.layout.scope.length > 0 ? capture.layout.scope.join(', ') : 'repository',
      modules: snapshot.analysis.modules,
      relationships: snapshot.analysis.relationships,
      commits: explanationContext.commits,
      commitsTruncated: explanationContext.commitsTruncated,
      diff: explanationContext.diff,
      diffTruncated: explanationContext.diffTruncated,
    })
    const stateKey = explanationKey(key, request.snapshotId)
    const previous = this.explanations.get(stateKey)
    if (previous?.status === 'waiting')
      throw new Error('Architecture explanation is already running')
    this.explanations.set(stateKey, {
      status: 'waiting',
      snapshotId: request.snapshotId,
      output: '',
    })
    let text: string
    let acceptingOutput = true
    try {
      text = await model.generate(host, {
        projectRoot,
        workspaceRoot: request.root,
        profileId: request.profileId,
        launchRevision: request.launchRevision,
        prompt,
        signal: review.controller.signal,
        onOutput: (output) => {
          if (!acceptingOutput || this.reviews.get(key)?.controller !== review.controller)
            return
          const state = {
            status: 'waiting' as const,
            snapshotId: request.snapshotId,
            output,
          }
          this.explanations.set(stateKey, state)
          publish(state)
        },
      })
      acceptingOutput = false
    } catch (cause) {
      acceptingOutput = false
      if (previous) this.explanations.set(stateKey, previous)
      else this.explanations.delete(stateKey)
      throw cause
    }
    this.assertLive(owner, key, review.controller)
    let state: ArchitectureExplanationState
    try {
      state = {
        status: 'ready',
        explanation: checkArchitectureExplanation(
          parseArchitectureExplanation(text),
          snapshot,
        ),
      }
    } catch (cause) {
      if (!(cause instanceof ArchitectureExplanationError)) throw cause
      state = {
        status: 'invalid',
        snapshotId: request.snapshotId,
        message: cause.message,
      }
    }
    this.explanations.set(stateKey, state)
    return state
  }

  explanation(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureExplanationRequest,
  ): ArchitectureExplanationState | null {
    this.ports.resources.assertCurrent(owner)
    const key = reviewKey(owner, request)
    if (this.reviews.get(key)?.host !== host)
      throw new Error('Architecture snapshot is unavailable; refresh the review')
    return this.explanations.get(explanationKey(key, request.snapshotId)) ?? null
  }

  /** Spends the launch before the native start: a session never silently duplicates. */
  launchPayload(
    owner: RendererOwner,
    host: ProjectHost,
    launch: ArchitectureAgentLaunch,
  ): string {
    this.ports.resources.assertCurrent(owner)
    return this.launches.consume(owner, host, launch)
  }

  assertLaunchCurrent(
    owner: RendererOwner,
    host: ProjectHost,
    launch: ArchitectureAgentLaunch,
  ): void {
    this.ports.resources.assertCurrent(owner)
    this.launches.assertCurrent(owner, host, launch)
  }

  close(owner: RendererOwner, request: ArchitectureReviewKey): void {
    const key = reviewKey(owner, request)
    this.stopFollower(key)
    this.closeReview(owner, request)
  }
  private closeReview(
    owner: RendererOwner,
    request: ArchitectureReviewKey,
    preserveExplanations = false,
  ): void {
    const key = reviewKey(owner, request)
    const review = this.reviews.get(key)
    if (!review) return
    this.reviews.delete(key)
    if (!preserveExplanations) this.clearExplanations(key)
    review.controller.abort(new Error('Architecture review cancelled or revoked'))
    void Promise.resolve()
      .then(() => review.stopConnection?.())
      .catch((error: unknown) => {
        console.error(
          '[architecture-review] connection subscription cleanup failed',
          error,
        )
      })
    review.lease.release()
  }
  dispose(): void {
    for (const key of this.followers.keys()) this.stopFollower(key)
    for (const review of this.reviews.values()) {
      review.controller.abort(new Error('Architecture review disposed'))
      void Promise.resolve()
        .then(() => review.stopConnection?.())
        .catch((error: unknown) => {
          console.error(
            '[architecture-review] connection subscription cleanup failed',
            error,
          )
        })
      review.lease.release()
    }
    this.reviews.clear()
    this.explanations.clear()
    this.launches.clear()
  }
  private stopFollower(key: string): void {
    const follower = this.followers.get(key)
    if (!follower) return
    this.followers.delete(key)
    if (follower.timer) clearTimeout(follower.timer)
    void Promise.resolve(follower.stop()).catch((error: unknown) => {
      console.error('[architecture-review] live watch cleanup failed', error)
    })
  }
  /** Offers `planned` as the one handoff the review allows next. */
  private reoffer(
    key: string,
    request: ArchitectureEvidenceRequest,
    planned: PlannedHandoff,
  ): ArchitecturePreparedReview {
    if (planned.kind !== 'review' || planned.path === undefined)
      throw new Error('Architecture review preview changed; prepare again')
    this.reviews.set(key, { ...this.reviews.get(key)!, plan: planned })
    return {
      ...request,
      snapshotId: planned.snapshotId,
      path: joinHostPath(request.root, planned.path),
      body: planned.body,
      digest: planned.digest,
      handoff: planned.plan,
    }
  }

  /** Brief, then launch. A failure keeps the step for this review to finish later. */
  private async finishHandoff(
    owner: RendererOwner,
    host: ProjectHost,
    key: string,
    controller: AbortController,
    step: UnfinishedHandoff,
  ): Promise<ArchitectureHandoff> {
    const { planned, added } = step
    let briefWritten = step.briefWritten
    try {
      if (!briefWritten)
        await (this.ports.handoff!.writeBrief ?? writeArchitectureBrief)(
          host,
          added.root,
          planned.plan.brief,
          AbortSignal.timeout(STRIP_TIMEOUT),
        )
      briefWritten = true
      this.ports.resources.assertCurrent(owner)
    } catch (cause) {
      const review = this.reviews.get(key)
      if (review?.controller === controller)
        this.reviews.set(key, { ...review, unfinished: { ...step, briefWritten } })
      throw new Error(
        `The agent worktree ${added.root.path} was created, but the handoff did not finish: ${cause instanceof Error ? cause.message : String(cause)}. Prepare the agent handoff again to finish it in that worktree.`,
        { cause },
      )
    }
    const launch = this.launches.issue(
      owner,
      host,
      added.root,
      planned.digest,
      planned.body,
    )
    return {
      projectId: added.projectId,
      workspaceId: added.workspaceId,
      branch: added.branch,
      worktree: added.root,
      launch,
    }
  }

  /** Fresh evidence and the commit a handoff from it starts at. */
  private async freshHandoffBase(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureEvidenceRequest,
  ): Promise<{ key: string; commit: string }> {
    const evidence = await this.evidence(owner, host, { ...request, capturedOnly: false })
    if (evidence.stale !== false)
      throw new Error('Architecture evidence is stale; refresh before launching')
    const key = reviewKey(owner, request)
    const { controller, capture } = this.reviews.get(key)!
    const base = await (this.ports.handoff?.liveBase ?? readArchitectureLiveBase)(
      host,
      request.root,
      controller.signal,
    )
    this.assertLive(owner, key, controller)
    const live = capture!.currentRevision === ARCHITECTURE_LIVE_REVISION
    const commit = handoffCommit(live ? undefined : capture!.currentRevision, base)
    return { key, commit }
  }

  private currentSnapshot(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureExplanationRequest,
  ): { key: string; review: Review } {
    const key = reviewKey(owner, request)
    const review = this.reviews.get(key)
    if (
      !review?.capture ||
      !review.snapshot ||
      review.snapshot.id !== request.snapshotId ||
      review.host !== host
    )
      throw new Error('Architecture snapshot is unavailable; refresh the review')
    return { key, review }
  }

  private worktrees(): ArchitectureWorktreePort {
    const worktrees = this.ports.handoff?.worktrees
    if (!worktrees) throw new Error('Agent handoff is unavailable in this window')
    return worktrees
  }

  private clearExplanations(scope: string): void {
    for (const key of this.explanations.keys()) {
      if (key.startsWith(`${scope}\0`)) this.explanations.delete(key)
    }
  }

  /** The live state is read first: an edit racing the capture can only make it stale. */
  private async capture(
    host: ProjectHost,
    request: ArchitectureReviewRequest,
    signal: AbortSignal,
    recorder: ArchitectureScanRecorder,
  ): Promise<{ capture: ArchitectureCapture; liveState?: string }> {
    validateArchitectureRequest(host, request)
    const liveState = hasLiveCurrent(request)
      ? await this.readLiveState(host, request, signal, recorder)
      : undefined
    const capture = await (this.ports.capture ?? captureArchitecture)(
      host,
      request,
      signal,
      recorder,
      this.blobs,
    )
    return { capture, liveState }
  }
  /** A commit pair never goes stale; a live end is compared by its cheap state digest. */
  private async isStale(review: Review): Promise<boolean> {
    if (review.liveState === undefined) return false
    const current = await this.readLiveState(
      review.host,
      review.request,
      review.controller.signal,
    )
    return current !== review.liveState
  }
  private readLiveState(
    host: ProjectHost,
    request: ArchitectureReviewRequest,
    signal: AbortSignal,
    recorder?: ArchitectureScanRecorder,
  ): Promise<string> {
    return (this.ports.liveState ?? readArchitectureLiveState)(
      host,
      request.root,
      signal,
      recorder,
    )
  }
  private assertLive(
    owner: RendererOwner,
    key: string,
    controller: AbortController,
  ): void {
    controller.signal.throwIfAborted()
    this.ports.resources.assertCurrent(owner)
    if (this.reviews.get(key)?.controller !== controller)
      throw new Error('Architecture review cancelled')
  }
}
function reviewKey(owner: RendererOwner, request: ArchitectureReviewKey): string {
  if (
    !request ||
    typeof request.reviewId !== 'string' ||
    !/^[\w-]{1,80}$/.test(request.reviewId) ||
    !request.root ||
    typeof request.root.hostId !== 'string' ||
    typeof request.root.path !== 'string'
  )
    throw new Error('Invalid architecture review identity')
  return JSON.stringify([
    owner.id,
    owner.generation,
    request.root.hostId,
    request.root.path,
    request.reviewId,
  ])
}

function explanationKey(scope: string, snapshotId: string): string {
  return `${scope}\0${snapshotId}`
}

function relativeArchitecturePath(
  root: HostPath,
  candidate: HostPath,
): string | undefined {
  if (!containsHostPath(root, candidate) || hostPathEquals(root, candidate))
    return undefined
  return candidate.path.slice(root.path === '/' ? 1 : root.path.length + 1)
}

/**
 * The diff base the viewer keys captured inputs by. Captured inputs are never re-resolved;
 * a commit pair names its Current commit so no editor buffer is ever mixed in.
 */
function evidenceBase(
  capture: ArchitectureCapture,
): Pick<ArchitectureEvidence['diff'], 'base' | 'revision'> {
  return capture.currentRevision === ARCHITECTURE_LIVE_REVISION
    ? { base: 'working-tree' }
    : { base: 'head', revision: capture.currentRevision }
}

/** A diff side label: the ref as chosen, with the commit it resolved to. */
function endLabel(ref: string, revision: string): string {
  if (revision === ARCHITECTURE_LIVE_REVISION) return ref
  const short = revision.slice(0, 12)
  return ref === revision || ref === short ? short : `${ref} (${short})`
}

function matchesPlan(
  planned: PlannedHandoff,
  request: ArchitectureReviewLaunch,
): boolean {
  if (planned.kind !== 'review' || planned.path === undefined) return false
  return (
    typeof request.digest === 'string' &&
    request.digest === planned.digest &&
    request.snapshotId === planned.snapshotId &&
    !!request.path &&
    hostPathEquals(joinHostPath(request.root, planned.path), request.path)
  )
}
