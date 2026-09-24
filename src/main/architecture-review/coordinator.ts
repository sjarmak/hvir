import { randomUUID } from 'node:crypto'
import { hostPathEquals, joinHostPath, type HostPath } from '../../shared/host-path'
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
  ArchitectureEvidence,
  ArchitecturePreparedReview,
  ArchitectureReviewLaunch,
  ArchitectureEvidenceRequest,
  ArchitectureReviewKey,
  ArchitectureReviewRequest,
  ArchitectureReviewSnapshot,
} from '../../shared/architecture-review'
import { ARCHITECTURE_LIVE_REVISION } from '../../shared/architecture-review'
import type { ProjectHost } from '../project-host/project-host'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import { captureArchitecture, validateArchitectureRequest } from './capture'
import { listArchitectureCommits } from './commit-range'
import { hasLiveCurrent } from './ends'
import { readArchitectureLiveState } from './freshness'
import { ArchitectureScanRecorder } from './scan-recorder'
import { architectureReviewPrompt, architecturePromptDigest } from './prompt'
import { recordArchitectureScope } from './scope-record'

const MAX_REVIEWS = 4
const STRIP_TIMEOUT = 60_000
export interface ArchitectureReviewPorts {
  readonly resources: RendererResourceScopes
  readonly capture?: typeof captureArchitecture
  readonly liveState?: typeof readArchitectureLiveState
  readonly commits?: typeof listArchitectureCommits
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
  readonly launched?: boolean
  readonly snapshot?: ArchitectureReviewSnapshot
}
/** Workspace leases own bounded captured pairs; analysis owns no host authority. */
export class ArchitectureReviewCoordinator {
  private readonly reviews = new Map<string, Review>()
  constructor(private readonly ports: ArchitectureReviewPorts) {}

  async scan(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureReviewRequest,
  ): Promise<ArchitectureReviewSnapshot> {
    this.ports.resources.assertCurrent(owner)
    const key = reviewKey(owner, request)
    this.close(owner, request)
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
      const analysis = await this.ports.analyze(capture, controller.signal, recorder)
      this.assertLive(owner, key, controller)
      const { before: _before, after: _after, configs: _configs, ...metadata } = capture
      const payload = { ...metadata, id: randomUUID(), analysis }
      // The renderer receives this payload over IPC; its serialized size is the transfer cost.
      recorder.measureSync(
        'renderer-payload',
        () => Buffer.byteLength(JSON.stringify(payload)),
        (bytes) => ({ bytes, items: 1 }),
      )
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

  async prepare(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureEvidenceRequest,
  ): Promise<ArchitecturePreparedReview> {
    const evidence = await this.evidence(owner, host, { ...request, capturedOnly: false })
    if (evidence.stale !== false)
      throw new Error('Architecture evidence is stale; refresh before launching')
    const review = this.reviews.get(reviewKey(owner, request))!
    if (review.launched)
      throw new Error('A review agent was already launched for this snapshot')
    const source = [...review.capture!.before, ...review.capture!.after].find((file) =>
      hostPathEquals(joinHostPath(request.root, file.path), request.path),
    )!
    const body = architectureReviewPrompt(
      review.capture!,
      request.snapshotId,
      source.path,
    )
    return { ...request, body, digest: architecturePromptDigest(body) }
  }

  async launchPayload(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureReviewLaunch,
  ): Promise<string> {
    const prepared = await this.prepare(owner, host, request)
    if (typeof request.digest !== 'string' || request.digest !== prepared.digest)
      throw new Error('Architecture review preview changed; prepare again')
    const key = reviewKey(owner, request)
    const review = this.reviews.get(key)!
    // Spend before native launch: an uncertain launch must never silently duplicate a session.
    if (review.launched) throw new Error('Architecture review launch already consumed')
    this.reviews.set(key, { ...review, launched: true })
    return prepared.body
  }

  assertLaunchCurrent(
    owner: RendererOwner,
    host: ProjectHost,
    request: ArchitectureReviewLaunch,
  ): void {
    const key = reviewKey(owner, request)
    const review = this.reviews.get(key)
    if (
      !review?.launched ||
      review.snapshot?.id !== request.snapshotId ||
      review.host !== host
    )
      throw new Error('Architecture review launch was cancelled')
    this.assertLive(owner, key, review.controller)
  }

  close(owner: RendererOwner, request: ArchitectureReviewKey): void {
    const key = reviewKey(owner, request)
    const review = this.reviews.get(key)
    if (!review) return
    this.reviews.delete(key)
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
