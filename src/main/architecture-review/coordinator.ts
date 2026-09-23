import { randomUUID } from 'node:crypto'
import { hostPathEquals, joinHostPath } from '../../shared/host-path'
import { measureTextWorkload } from '../../shared/viewer-workload-policy'
import type { ArchitectureAnalysis } from '../../shared/architecture-analysis'
import type {
  ArchitectureCapture,
  ArchitectureEvidence,
  ArchitecturePreparedReview,
  ArchitectureReviewLaunch,
  ArchitectureEvidenceRequest,
  ArchitectureReviewKey,
  ArchitectureReviewRequest,
  ArchitectureReviewSnapshot,
} from '../../shared/architecture-review'
import type { ProjectHost } from '../project-host/project-host'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import { captureArchitecture } from './capture'
import { architectureReviewPrompt, architecturePromptDigest } from './prompt'

const MAX_REVIEWS = 4
export interface ArchitectureReviewPorts {
  readonly resources: RendererResourceScopes
  readonly capture?: typeof captureArchitecture
  readonly analyze: (
    capture: ArchitectureCapture,
    signal: AbortSignal,
  ) => Promise<ArchitectureAnalysis>
}
interface Review {
  readonly controller: AbortController
  readonly host: ProjectHost
  readonly request: ArchitectureReviewRequest
  readonly lease: RendererResourceLease
  readonly stopConnection?: () => void | Promise<void>
  readonly capture?: ArchitectureCapture
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
      const capture = await (this.ports.capture ?? captureArchitecture)(
        host,
        request,
        controller.signal,
      )
      this.assertLive(owner, key, controller)
      const analysis = await this.ports.analyze(capture, controller.signal)
      this.assertLive(owner, key, controller)
      const { before: _before, after: _after, ...metadata } = capture
      const snapshot: ArchitectureReviewSnapshot = {
        ...metadata,
        id: randomUUID(),
        analysis,
      }
      this.reviews.set(key, { ...review, capture, snapshot })
      return snapshot
    } catch (error) {
      if (this.reviews.get(key)?.controller === controller) this.close(owner, request)
      throw error
    }
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
    const current = await (this.ports.capture ?? captureArchitecture)(
      host,
      review.request,
      review.controller.signal,
    )
    this.assertLive(owner, key, review.controller)
    return {
      snapshotId: review.snapshot.id,
      stale: current.fingerprint !== capture.fingerprint,
      diff: {
        path: request.path,
        base: capture.mode === 'commit' ? 'head' : capture.mode,
        baseLabel: capture.baselineRevision,
        currentLabel: capture.currentRevision,
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
    const evidence = await this.evidence(owner, host, request)
    if (evidence.stale)
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
