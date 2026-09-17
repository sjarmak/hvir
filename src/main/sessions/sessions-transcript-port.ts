/**
 * The one transcript a renderer may be watching.
 *
 * Demand scoped like every other Sessions observation: one subscription per
 * renderer, for the single selected row, released on hide, navigation, renderer
 * rollover, or a change of selection. Sessions owns no stream at list altitude
 * (ADR-046), so nothing here opens until a row is selected and nothing survives
 * its release.
 *
 * A dropped socket is reported, not retried. ADR-047 makes resumption the
 * caller's decision, so a lost stream becomes a visible state the renderer
 * resumes from the server's own cursor; this port never reconnects behind the
 * pane's back.
 */
import {
  MAX_SESSIONS_TRANSCRIPT_TURNS,
  SESSIONS_TRANSCRIPT_VERSION,
  type SessionsTerminalHandle,
  type SessionsTranscriptChange,
  type SessionsTranscriptRequest,
  type SessionsTranscriptSnapshot,
  type SessionsTranscriptStreamState,
  type SessionsTranscriptUnavailableReason,
} from '../../shared'
import type {
  SupervisorAccess,
  SupervisorSessionAddress,
} from '../gascity/supervisor-access'
import type { SupervisorStreamSubscription } from '../gascity/supervisor-client'
import type { Disposer } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import {
  sessionsProjectionRootKey,
  type SessionsExternalSessionTarget,
} from './sessions-projection-identities'
import type { SessionsObservationPort } from './sessions-observation-port'
import {
  emptySessionsTranscriptFold,
  foldSessionsTranscriptEvent,
  foldSessionsTranscriptSnapshot,
  sessionsTranscriptTurns,
  type SessionsTranscriptFold,
} from './sessions-transcript-projection'

export interface SessionsTranscriptPortOptions {
  readonly sessions: Pick<
    SessionsObservationPort,
    'resolveExternalSession' | 'currentExternalSession' | 'observeSourceChanges'
  >
  readonly supervisor: SupervisorAccess
  readonly emit: (owner: RendererOwner, change: SessionsTranscriptChange) => void
}

interface TranscriptLease {
  readonly owner: RendererOwner
  readonly demandGeneration: number
  readonly projectionDemandGeneration: number
  handle: SessionsTerminalHandle
  /**
   * Bumped whenever the subscription is reopened, retargeted, or dropped, so an
   * awaited read or a queued stream callback from the previous attempt is
   * discarded instead of landing on the current one.
   */
  epoch: number
  fold: SessionsTranscriptFold
  status: SessionsTranscriptSnapshot['status']
  reason?: SessionsTranscriptUnavailableReason
  stream: SessionsTranscriptStreamState
  streamReason?: SessionsTranscriptUnavailableReason
  /** The session this subscription is reading, as main recorded it. */
  targetKey?: string
  subscription?: SupervisorStreamSubscription
  /** The server's resume position, held across a socket drop. */
  cursor?: string
  revision: number
  notifyQueued: boolean
}

export class SessionsTranscriptPort {
  private readonly leases = new Map<string, TranscriptLease>()
  private stopObservingSessions?: Disposer
  private disposed = false

  constructor(private readonly options: SessionsTranscriptPortOptions) {}

  /**
   * Starts, or retargets, the one subscription this renderer may hold. A new
   * selection replaces the previous one rather than adding to it: the demand is
   * for whatever row is selected, and only one row is.
   */
  acquire(
    owner: RendererOwner,
    request: SessionsTranscriptRequest,
  ): SessionsTranscriptSnapshot {
    this.validateRequest(request)
    if (this.disposed) throw new Error('Sessions transcript observation is disposed')
    const key = ownerKey(owner)
    const current = this.leases.get(key)
    if (current && current.demandGeneration !== request.demandGeneration) {
      throw new Error('Sessions transcript demand is already active')
    }
    if (current) {
      if (current.handle === request.handle) {
        return this.snapshot(owner, request.demandGeneration)
      }
      this.retarget(current, request.handle)
      void this.load(current, request)
      return this.snapshot(owner, request.demandGeneration)
    }
    const lease: TranscriptLease = {
      owner,
      demandGeneration: request.demandGeneration,
      projectionDemandGeneration: request.projectionDemandGeneration,
      handle: request.handle,
      epoch: 1,
      fold: emptySessionsTranscriptFold(),
      status: 'loading',
      stream: 'opening',
      revision: 1,
      notifyQueued: false,
    }
    this.leases.set(key, lease)
    this.startSourceObservation()
    void this.load(lease, request)
    return this.snapshot(owner, request.demandGeneration)
  }

  snapshot(owner: RendererOwner, demandGeneration: number): SessionsTranscriptSnapshot {
    const lease = this.leases.get(ownerKey(owner))
    if (!lease || lease.demandGeneration !== demandGeneration) {
      throw new Error('Sessions transcript demand is no longer current')
    }
    return {
      version: SESSIONS_TRANSCRIPT_VERSION,
      demandGeneration,
      revision: lease.revision,
      handle: lease.handle,
      status: lease.status,
      ...(lease.reason === undefined ? {} : { reason: lease.reason }),
      stream: lease.stream,
      ...(lease.streamReason === undefined ? {} : { streamReason: lease.streamReason }),
      turns: sessionsTranscriptTurns(lease.fold),
      older: lease.fold.older,
      dropped: lease.fold.dropped,
    }
  }

  /**
   * Reopens a stream the transport dropped, from the position the server last
   * acknowledged. Explicit by design: the pane says it is still watching, and
   * the turns already folded are kept rather than replayed.
   */
  resume(owner: RendererOwner, demandGeneration: number): SessionsTranscriptSnapshot {
    const lease = this.leases.get(ownerKey(owner))
    if (!lease || lease.demandGeneration !== demandGeneration) {
      throw new Error('Sessions transcript demand is no longer current')
    }
    if (lease.stream === 'lost' && lease.status === 'ready') {
      this.closeStream(lease)
      lease.stream = 'opening'
      delete lease.streamReason
      lease.revision += 1
      this.queueNotification(lease)
      void this.open(lease, lease.epoch)
    }
    return this.snapshot(owner, demandGeneration)
  }

  release(owner: RendererOwner, demandGeneration: number): boolean {
    const key = ownerKey(owner)
    const lease = this.leases.get(key)
    if (!lease || lease.demandGeneration !== demandGeneration) return false
    this.leases.delete(key)
    this.stopLease(lease)
    this.stopSourceObservationIfIdle()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    void this.stopObservingSessions?.()
    this.stopObservingSessions = undefined
    for (const lease of this.leases.values()) this.stopLease(lease)
    this.leases.clear()
  }

  /** Streams this port holds open, so a hide can be asserted to leave none. */
  get openStreams(): number {
    let open = 0
    for (const lease of this.leases.values()) if (lease.subscription) open += 1
    return open
  }

  private async load(
    lease: TranscriptLease,
    request: Pick<
      SessionsTranscriptRequest,
      'handle' | 'projectionDemandGeneration' | 'sourceRevision'
    >,
  ): Promise<void> {
    const epoch = lease.epoch
    const resolved = this.options.sessions.resolveExternalSession(lease.owner, request)
    if (resolved.outcome === 'unavailable') {
      this.fail(lease, epoch, resolved.reason)
      return
    }
    await this.read(lease, epoch, resolved.target)
  }

  /** Reads the transcript for a session already resolved, then follows it. */
  private async read(
    lease: TranscriptLease,
    epoch: number,
    target: SessionsExternalSessionTarget,
  ): Promise<void> {
    lease.targetKey = targetKey(target)
    const address = await this.options.supervisor.address(accessTarget(target))
    if (!this.live(lease, epoch)) return
    if (!address.ok) {
      this.fail(lease, epoch, address.failure.reason)
      return
    }
    const read = await address.value.client.transcript(
      address.value.cityName,
      target.key,
      {
        tail: MAX_SESSIONS_TRANSCRIPT_TURNS,
      },
    )
    if (!this.live(lease, epoch)) return
    if (!read.ok) {
      this.fail(lease, epoch, read.failure.reason)
      return
    }
    lease.fold = foldSessionsTranscriptSnapshot(read.value)
    lease.cursor = lease.fold.cursor
    lease.status = 'ready'
    delete lease.reason
    lease.revision += 1
    this.queueNotification(lease)
    await this.open(lease, epoch, { address: address.value, key: target.key })
  }

  private async open(
    lease: TranscriptLease,
    epoch: number,
    resolved?: StreamAddress,
  ): Promise<void> {
    const found = resolved ?? (await this.readdress(lease, epoch))
    if (found === undefined) return
    const subscription = await found.address.client.streamSession(
      found.address.cityName,
      found.key,
      {
        onEvent: (event) => {
          if (!this.live(lease, epoch) || event.kind !== 'structured') return
          lease.fold = foldSessionsTranscriptEvent(lease.fold, event.data)
          lease.cursor = lease.fold.cursor ?? lease.cursor
          if (lease.stream === 'opening') lease.stream = 'live'
          lease.revision += 1
          this.queueNotification(lease)
        },
        onClose: (failure) => {
          if (!this.live(lease, epoch)) return
          lease.cursor = lease.subscription?.cursor ?? lease.cursor
          delete lease.subscription
          // A clean end is the session's end; a failure is a drop the pane can
          // resume. Neither reconnects here.
          lease.stream = failure === undefined ? 'closed' : 'lost'
          if (failure !== undefined) lease.streamReason = failure.reason
          lease.revision += 1
          this.queueNotification(lease)
        },
      },
      lease.cursor,
    )
    // The lease may have been released or retargeted while the socket opened.
    if (!this.live(lease, epoch)) {
      subscription.close()
      return
    }
    lease.subscription = subscription
    if (lease.stream === 'opening') {
      lease.stream = 'live'
      lease.revision += 1
      this.queueNotification(lease)
    }
  }

  /** The address for a resume, re-resolved because the projection may have moved. */
  private async readdress(
    lease: TranscriptLease,
    epoch: number,
  ): Promise<StreamAddress | undefined> {
    const current = this.options.sessions.currentExternalSession(
      lease.owner,
      lease.projectionDemandGeneration,
      lease.handle,
    )
    if (current.outcome === 'unavailable') {
      this.fail(lease, epoch, current.reason)
      return undefined
    }
    const address = await this.options.supervisor.address(accessTarget(current.target))
    if (!this.live(lease, epoch)) return undefined
    if (!address.ok) {
      this.streamFailed(lease, address.failure.reason)
      return undefined
    }
    return { address: address.value, key: current.target.key }
  }

  private fail(
    lease: TranscriptLease,
    epoch: number,
    reason: SessionsTranscriptUnavailableReason,
  ): void {
    if (!this.live(lease, epoch)) return
    this.closeStream(lease)
    lease.status = 'unavailable'
    lease.reason = reason
    lease.stream = 'closed'
    delete lease.streamReason
    lease.fold = emptySessionsTranscriptFold()
    lease.cursor = undefined
    lease.revision += 1
    this.queueNotification(lease)
  }

  /** The transcript stands; only the live stream is gone. */
  private streamFailed(
    lease: TranscriptLease,
    reason: SessionsTranscriptUnavailableReason,
  ): void {
    lease.stream = 'lost'
    lease.streamReason = reason
    lease.revision += 1
    this.queueNotification(lease)
  }

  private retarget(lease: TranscriptLease, handle: SessionsTerminalHandle): void {
    this.closeStream(lease)
    lease.epoch += 1
    lease.handle = handle
    lease.fold = emptySessionsTranscriptFold()
    lease.cursor = undefined
    lease.status = 'loading'
    delete lease.reason
    lease.stream = 'opening'
    delete lease.streamReason
    delete lease.targetKey
    lease.revision += 1
    this.queueNotification(lease)
  }

  private reconcileSourceChange(lease: TranscriptLease): void {
    if (!this.ownsLease(lease) || lease.targetKey === undefined) return
    const current = this.options.sessions.currentExternalSession(
      lease.owner,
      lease.projectionDemandGeneration,
      lease.handle,
    )
    if (current.outcome === 'unavailable') {
      this.fail(lease, lease.epoch, current.reason)
      return
    }
    // The row still stands for the same session, so the subscription stands too.
    if (targetKey(current.target) === lease.targetKey) return
    // The handle now names a different session: what is on screen is not that
    // session's transcript, so the subscription is replaced rather than amended.
    this.retarget(lease, lease.handle)
    void this.read(lease, lease.epoch, current.target)
  }

  private queueNotification(lease: TranscriptLease): void {
    if (lease.notifyQueued) return
    lease.notifyQueued = true
    queueMicrotask(() => {
      lease.notifyQueued = false
      if (!this.ownsLease(lease)) return
      this.options.emit(lease.owner, {
        demandGeneration: lease.demandGeneration,
        revision: lease.revision,
        handle: lease.handle,
      })
    })
  }

  private stopLease(lease: TranscriptLease): void {
    lease.epoch += 1
    this.closeStream(lease)
    lease.fold = emptySessionsTranscriptFold()
    lease.cursor = undefined
  }

  private closeStream(lease: TranscriptLease): void {
    const subscription = lease.subscription
    delete lease.subscription
    subscription?.close()
  }

  private startSourceObservation(): void {
    this.stopObservingSessions ??= this.options.sessions.observeSourceChanges(() => {
      for (const lease of this.leases.values()) this.reconcileSourceChange(lease)
    })
  }

  private stopSourceObservationIfIdle(): void {
    if (this.leases.size > 0) return
    void this.stopObservingSessions?.()
    this.stopObservingSessions = undefined
  }

  private live(lease: TranscriptLease, epoch: number): boolean {
    return this.ownsLease(lease) && lease.epoch === epoch
  }

  private ownsLease(lease: TranscriptLease): boolean {
    return !this.disposed && this.leases.get(ownerKey(lease.owner)) === lease
  }

  private validateRequest(request: SessionsTranscriptRequest): void {
    if (
      !positiveGeneration(request.demandGeneration) ||
      !positiveGeneration(request.projectionDemandGeneration) ||
      !Number.isSafeInteger(request.sourceRevision) ||
      request.sourceRevision <= 0
    ) {
      throw new Error('Invalid Sessions transcript demand')
    }
  }
}

interface StreamAddress {
  readonly address: SupervisorSessionAddress
  readonly key: string
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function positiveGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function accessTarget(target: SessionsExternalSessionTarget): {
  readonly hostId: SessionsExternalSessionTarget['hostId']
  readonly cityRoot?: SessionsExternalSessionTarget['cityRoot']
} {
  return {
    hostId: target.hostId,
    ...(target.cityRoot === undefined ? {} : { cityRoot: target.cityRoot }),
  }
}

/** Identity of the session a subscription is reading, for reconciliation only. */
function targetKey(target: SessionsExternalSessionTarget): string {
  return `${target.sourceId}\u0000${sessionsProjectionRootKey(target.hostId, target.key)}`
}
