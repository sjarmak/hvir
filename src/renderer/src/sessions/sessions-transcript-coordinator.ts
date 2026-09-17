/**
 * The renderer half of one transcript detail.
 *
 * Demand scoping is the whole point of this class. Sessions holds no stream at
 * list altitude (ADR-046): a transcript exists only while one row is selected
 * and the pane is showing, and the lease is released when the selection
 * changes, the list's own demand rolls over, hvir leaves the foreground, or the
 * pane closes. Main owns the socket; this owns the demand and the state a pane
 * renders from.
 */
import {
  SESSIONS_TRANSCRIPT_VERSION,
  type HvirApi,
  type SessionsDemandRequest,
  type SessionsProjectionSnapshot,
  type SessionsTerminalHandle,
  type SessionsTranscriptChange,
  type SessionsTranscriptRequest,
  type SessionsTranscriptSnapshot,
  type SessionsTranscriptUnavailableReason,
} from '../../../shared'

export interface SessionsTranscriptMainPort {
  observe(request: SessionsTranscriptRequest): Promise<SessionsTranscriptSnapshot>
  snapshot(request: SessionsDemandRequest): Promise<SessionsTranscriptSnapshot>
  resume(request: SessionsDemandRequest): Promise<SessionsTranscriptSnapshot>
  release(request: SessionsDemandRequest): Promise<void>
  subscribe(listener: (change: SessionsTranscriptChange) => void): () => void
}

export class SessionsTranscriptCoordinator {
  private readonly listeners = new Set<() => void>()
  private current?: SessionsTranscriptSnapshot
  private handle?: SessionsTerminalHandle
  private demandGeneration = 0
  private projectionDemandGeneration = 0
  private active = false
  private unsubscribe?: () => void
  private refreshInFlight = false
  private pendingRevision = 0
  private disposed = false

  constructor(private readonly main: SessionsTranscriptMainPort) {}

  snapshot = (): SessionsTranscriptSnapshot | undefined => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  selectedHandle(): SessionsTerminalHandle | undefined {
    return this.handle
  }

  /** Reads one row's transcript and follows it, replacing whatever was held. */
  open(handle: SessionsTerminalHandle, projection: SessionsProjectionSnapshot): void {
    if (this.disposed) return
    if (projection.status !== 'available') {
      this.close()
      return
    }
    if (!this.active || this.projectionDemandGeneration !== projection.demandGeneration) {
      this.stop()
      this.start(projection)
    }
    this.handle = handle
    this.pendingRevision = 0
    const generation = this.demandGeneration
    this.publish({
      version: SESSIONS_TRANSCRIPT_VERSION,
      demandGeneration: generation,
      revision: 0,
      handle,
      status: 'loading',
      stream: 'opening',
      turns: [],
      older: false,
      dropped: 0,
    })
    void this.main
      .observe({
        demandGeneration: generation,
        projectionDemandGeneration: projection.demandGeneration,
        sourceRevision: projection.sourceRevision,
        handle,
      })
      .then(
        (snapshot) => this.accept(generation, handle, snapshot),
        () => this.unavailable(generation, handle, 'stale-projection'),
      )
  }

  /**
   * Keeps the demand honest against the list it hangs off. A projection lease
   * that rolled over invalidates this one, so the transcript is re-read under
   * the new lease rather than followed under a lease main has already dropped.
   */
  synchronize(projection: SessionsProjectionSnapshot, foreground: boolean): void {
    if (this.disposed || !this.active) return
    if (!foreground || projection.status !== 'available') {
      this.close()
      return
    }
    if (projection.demandGeneration === this.projectionDemandGeneration) return
    const handle = this.handle
    this.stop()
    if (handle) this.open(handle, projection)
  }

  /**
   * Reopens a dropped stream. Explicit by design: a lost transport is reported
   * and waits for a person, because a pane that silently reconnects cannot be
   * told apart from one that never lost anything (ADR-047).
   */
  resume(): void {
    if (this.disposed || !this.active) return
    const generation = this.demandGeneration
    const handle = this.handle
    if (!handle || this.current?.stream !== 'lost') return
    void this.main.resume({ demandGeneration: generation }).then(
      (snapshot) => this.accept(generation, handle, snapshot),
      () => this.unavailable(generation, handle, 'stale-projection'),
    )
  }

  close(): void {
    if (!this.active && this.current === undefined) return
    this.stop()
    this.current = undefined
    this.notify()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.close()
    this.listeners.clear()
  }

  private start(projection: SessionsProjectionSnapshot): void {
    this.demandGeneration += 1
    this.active = true
    this.projectionDemandGeneration = projection.demandGeneration
    const generation = this.demandGeneration
    this.unsubscribe = this.main.subscribe((change) => {
      if (
        !this.active ||
        this.demandGeneration !== generation ||
        change.demandGeneration !== generation ||
        change.handle !== this.handle ||
        change.revision <= (this.current?.revision ?? 0)
      ) {
        return
      }
      this.pendingRevision = Math.max(this.pendingRevision, change.revision)
      void this.refresh(generation, change.handle)
    })
  }

  private stop(): void {
    const released = this.active ? this.demandGeneration : undefined
    this.active = false
    this.handle = undefined
    this.pendingRevision = 0
    this.refreshInFlight = false
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (released !== undefined) {
      void this.main.release({ demandGeneration: released }).catch(() => undefined)
    }
  }

  private async refresh(
    generation: number,
    handle: SessionsTerminalHandle,
  ): Promise<void> {
    if (this.refreshInFlight || !this.isCurrent(generation, handle)) return
    this.refreshInFlight = true
    try {
      const snapshot = await this.main.snapshot({ demandGeneration: generation })
      this.accept(generation, handle, snapshot)
    } catch {
      // A released demand or a renderer rollover fails closed. The next
      // notification asks again under whatever demand is current then.
    } finally {
      if (this.isCurrent(generation, handle)) {
        this.refreshInFlight = false
        if (this.pendingRevision > (this.current?.revision ?? 0)) {
          void this.refresh(generation, handle)
        }
      }
    }
  }

  private accept(
    generation: number,
    handle: SessionsTerminalHandle,
    snapshot: SessionsTranscriptSnapshot,
  ): void {
    if (!this.isCurrent(generation, handle)) return
    if (
      snapshot.version !== SESSIONS_TRANSCRIPT_VERSION ||
      snapshot.demandGeneration !== generation ||
      snapshot.handle !== handle ||
      snapshot.revision < (this.current?.revision ?? 0)
    ) {
      return
    }
    if (this.pendingRevision <= snapshot.revision) this.pendingRevision = 0
    this.publish(snapshot)
  }

  private unavailable(
    generation: number,
    handle: SessionsTerminalHandle,
    reason: SessionsTranscriptUnavailableReason,
  ): void {
    if (!this.isCurrent(generation, handle)) return
    this.publish({
      version: SESSIONS_TRANSCRIPT_VERSION,
      demandGeneration: generation,
      revision: this.current?.revision ?? 0,
      handle,
      status: 'unavailable',
      reason,
      stream: 'closed',
      turns: [],
      older: false,
      dropped: 0,
    })
  }

  private isCurrent(generation: number, handle: SessionsTerminalHandle): boolean {
    return (
      !this.disposed &&
      this.active &&
      this.demandGeneration === generation &&
      this.handle === handle
    )
  }

  private publish(snapshot: SessionsTranscriptSnapshot): void {
    this.current = snapshot
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export function createSessionsTranscriptMainPort(
  api: Pick<HvirApi, 'invoke' | 'on'>,
): SessionsTranscriptMainPort {
  return {
    observe: (request) => api.invoke('sessions:transcript-observe', request),
    snapshot: (request) => api.invoke('sessions:transcript-snapshot', request),
    resume: (request) => api.invoke('sessions:transcript-resume', request),
    release: (request) => api.invoke('sessions:transcript-release', request),
    subscribe: (listener) => api.on('sessions:transcript-changed', listener),
  }
}

/** What a pane says about a transcript it cannot show. */
export function sessionsTranscriptUnavailableMessage(
  reason: SessionsTranscriptUnavailableReason,
): string {
  switch (reason) {
    case 'not-projected':
      return 'This session is no longer in the current Sessions view.'
    case 'stale-projection':
      return 'Sessions changed. Reopen the refreshed row to read its transcript.'
    case 'city-unknown':
      return 'No city on this host answers for that session.'
    case 'disabled':
      return 'The Gas City supervisor surface is turned off for this host.'
    case 'misconfigured':
      return 'The configured supervisor endpoint could not be read as one.'
    case 'unreachable':
      return 'The Gas City supervisor is not reachable on this host.'
    case 'timeout':
      return 'The Gas City supervisor did not answer in time.'
    case 'aborted':
      return 'The transcript request ended before it was answered.'
    case 'protocol':
      return 'The supervisor answered with something this build does not understand.'
    case 'not-found':
      return 'The supervisor no longer holds this session.'
    case 'denied':
      return 'The supervisor refused the request.'
    case 'conflict':
      return 'The supervisor reports the session in a conflicting state.'
    case 'rejected':
      return 'The supervisor rejected the request.'
    case 'unsupported':
      return 'This supervisor does not serve transcripts.'
    case 'unready':
      return 'The city backend is not serving transcripts yet.'
    case 'faulted':
      return 'The supervisor reported a fault reading this transcript.'
  }
}
