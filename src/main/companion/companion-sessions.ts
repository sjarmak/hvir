/**
 * The Companion's Sessions verbs (ADR-049): open a page, read its rows, select
 * a row's transcript, answer, message, close.
 *
 * Every open page holds one observation lease under a companion owner the
 * service mints (page id plus a service-wide generation), and at most one
 * transcript lease under the same owner. The service registers the one
 * companion sink and routes each change to the page whose owner and generation
 * it names. No page open means no lease held and no source subscribed: the
 * Companion is quiet when hidden. It never resolves an open, never attaches,
 * never asks for usage; those are renderer verbs the ports refuse it anyway.
 */
import { randomBytes } from 'node:crypto'

import {
  SESSIONS_COMPANION_VERSION,
  type CompanionClosedReason,
  type CompanionEvent,
  type CompanionRespondRequest,
  type CompanionSnapshot,
  type CompanionSubmitRequest,
  type SessionsMutationResponse,
  type SessionsObservationSnapshot,
  type SessionsProjectionChange,
  type SessionsTerminalHandle,
  type SessionsTranscriptChange,
  type SessionsTranscriptSnapshot,
} from '../../shared'
import type { ActionableAttentionSet } from '../attention/actionable-attention-set'
import type { Disposer } from '../project-host'
import type {
  SessionsCompanionSink,
  SessionsCompanionSinkRegistry,
} from '../sessions/sessions-companion-sinks'
import type { SessionsCompanionDemandOwner } from '../sessions/sessions-demand-owner'
import type { SessionsObservationPort } from '../sessions/sessions-observation-port'
import type { SessionsExternalSessionKey } from '../sessions/sessions-projection-identities'
import type { SessionsTranscriptPort } from '../sessions/sessions-transcript-port'
import { companionRows } from './companion-rows'

export interface CompanionSessionsPorts {
  readonly observation: Pick<
    SessionsObservationPort,
    'acquire' | 'snapshot' | 'release' | 'currentExternalSession'
  >
  readonly transcripts: Pick<
    SessionsTranscriptPort,
    'acquire' | 'snapshot' | 'resume' | 'release' | 'respond' | 'submit'
  >
  readonly actionable: Pick<ActionableAttentionSet, 'snapshot' | 'observe'>
  readonly sinks: Pick<SessionsCompanionSinkRegistry, 'register'>
  /** Page ids are random by default; a test names them. */
  readonly mintPageId?: () => string
}

export type CompanionEventListener = (event: CompanionEvent) => void

export interface CompanionOpenPage {
  readonly pageId: string
  readonly snapshot: CompanionSnapshot
  readonly events: (listener: CompanionEventListener) => Disposer
}

interface CompanionPage {
  readonly id: string
  readonly owner: SessionsCompanionDemandOwner
  readonly listeners: Set<CompanionEventListener>
  selected?: SessionsTerminalHandle
  fingerprint: string
  snapshot: CompanionSnapshot
}

export class CompanionSessionsService {
  private readonly pages = new Map<string, CompanionPage>()
  private readonly unregisterSink: Disposer
  private stopObservingActionable?: () => void
  private generation = 0
  private disposed = false

  constructor(private readonly ports: CompanionSessionsPorts) {
    this.unregisterSink = ports.sinks.register(this.sink)
  }

  get openPages(): number {
    return this.pages.size
  }

  openPage(): CompanionOpenPage {
    if (this.disposed) throw new Error('Companion sessions are disposed')
    const id = this.ports.mintPageId?.() ?? randomBytes(16).toString('hex')
    if (this.pages.has(id)) throw new Error('Companion page is already open')
    const generation = (this.generation += 1)
    const owner: SessionsCompanionDemandOwner = {
      kind: 'companion',
      page: id,
      generation,
    }
    const observed = this.ports.observation.acquire(owner, generation)
    const page: CompanionPage = {
      id,
      owner,
      listeners: new Set(),
      fingerprint: '',
      snapshot: {
        version: SESSIONS_COMPANION_VERSION,
        revision: 0,
        demandGeneration: generation,
        rows: [],
      },
    }
    this.pages.set(id, page)
    this.refresh(page, observed)
    this.stopObservingActionable ??= this.ports.actionable.observe(() => {
      for (const open of [...this.pages.values()]) this.publish(open)
    })
    return {
      pageId: id,
      snapshot: page.snapshot,
      events: (listener) => this.listen(page, listener),
    }
  }

  snapshot(pageId: string): CompanionSnapshot {
    return this.page(pageId).snapshot
  }

  select(pageId: string, handle: SessionsTerminalHandle): SessionsTranscriptSnapshot {
    const page = this.page(pageId)
    const { generation } = page.owner
    const observed = this.ports.observation.snapshot(page.owner, generation)
    const snapshot = this.ports.transcripts.acquire(page.owner, {
      demandGeneration: generation,
      projectionDemandGeneration: generation,
      sourceRevision: observed.revision,
      handle,
    })
    page.selected = handle
    return snapshot
  }

  resume(pageId: string): SessionsTranscriptSnapshot {
    const page = this.selected(pageId)
    return this.ports.transcripts.resume(page.owner, page.owner.generation)
  }

  async respond(
    pageId: string,
    request: CompanionRespondRequest,
  ): Promise<SessionsMutationResponse> {
    const page = this.selected(pageId)
    return this.ports.transcripts.respond(page.owner, {
      demandGeneration: page.owner.generation,
      ...request,
    })
  }

  async submit(
    pageId: string,
    request: CompanionSubmitRequest,
  ): Promise<SessionsMutationResponse> {
    const page = this.selected(pageId)
    return this.ports.transcripts.submit(page.owner, {
      demandGeneration: page.owner.generation,
      ...request,
    })
  }

  /** Idempotent: a page closed twice, or closed after closeAll, is no error. */
  closePage(pageId: string): void {
    const page = this.pages.get(pageId)
    if (page === undefined) return
    this.pages.delete(pageId)
    this.releaseLeases(page)
    page.listeners.clear()
    if (this.pages.size === 0) {
      this.stopObservingActionable?.()
      this.stopObservingActionable = undefined
    }
  }

  /** Every page hears why before any lease goes, so a stream can say goodbye. */
  closeAll(reason: CompanionClosedReason): void {
    const pages = [...this.pages.values()]
    for (const page of pages) this.emit(page, { type: 'closed', reason })
    for (const page of pages) this.closePage(page.id)
  }

  dispose(): void {
    if (this.disposed) return
    this.closeAll('shutdown')
    void this.unregisterSink()
    this.disposed = true
  }

  private readonly sink: SessionsCompanionSink = {
    onProjectionChange: (owner, change) => this.projectionChanged(owner, change),
    // The Companion never leases usage (ADR-049), so nothing can arrive here.
    onUsageChange: () => undefined,
    onTranscriptChange: (owner, change) => this.transcriptChanged(owner, change),
  }

  private projectionChanged(
    owner: SessionsCompanionDemandOwner,
    change: SessionsProjectionChange,
  ): void {
    const page = this.pageFor(owner, change.demandGeneration)
    if (page !== undefined) this.publish(page)
  }

  private transcriptChanged(
    owner: SessionsCompanionDemandOwner,
    change: SessionsTranscriptChange,
  ): void {
    const page = this.pageFor(owner, change.demandGeneration)
    if (page === undefined || page.selected === undefined) return
    const transcript = this.ports.transcripts.snapshot(
      page.owner,
      change.demandGeneration,
    )
    this.emit(page, { type: 'transcript', transcript })
  }

  private pageFor(
    owner: SessionsCompanionDemandOwner,
    demandGeneration: number,
  ): CompanionPage | undefined {
    const page = this.pages.get(owner.page)
    if (page === undefined) return undefined
    const { generation } = page.owner
    return generation === owner.generation && generation === demandGeneration
      ? page
      : undefined
  }

  /** Rebuilds the page from current sources; a lost lease closes the page. */
  private publish(page: CompanionPage): void {
    const observed = this.currentObservation(page)
    if (observed === undefined) {
      this.emit(page, { type: 'closed', reason: 'lease-lost' })
      this.closePage(page.id)
      return
    }
    if (this.refresh(page, observed)) {
      this.emit(page, { type: 'snapshot', snapshot: page.snapshot })
    }
  }

  /** The port throws for one reason only: the lease is no longer current. */
  private currentObservation(
    page: CompanionPage,
  ): SessionsObservationSnapshot | undefined {
    try {
      return this.ports.observation.snapshot(page.owner, page.owner.generation)
    } catch {
      return undefined
    }
  }

  private refresh(page: CompanionPage, observed: SessionsObservationSnapshot): boolean {
    const rows = companionRows({
      observation: observed,
      actionable: this.ports.actionable.snapshot().entries,
      resolveExternal: (handle) => this.resolveExternal(page, handle),
    })
    const fingerprint = JSON.stringify(rows)
    if (fingerprint === page.fingerprint) return false
    page.fingerprint = fingerprint
    page.snapshot = {
      version: SESSIONS_COMPANION_VERSION,
      revision: page.snapshot.revision + 1,
      demandGeneration: page.owner.generation,
      rows,
    }
    return true
  }

  private resolveExternal(
    page: CompanionPage,
    handle: SessionsTerminalHandle,
  ): SessionsExternalSessionKey | undefined {
    const current = this.ports.observation.currentExternalSession(
      page.owner,
      page.owner.generation,
      handle,
    )
    if (current.outcome !== 'resolved') return undefined
    const { sourceId, hostId, key } = current.target
    return { sourceId, hostId, key }
  }

  private releaseLeases(page: CompanionPage): void {
    const { generation } = page.owner
    if (page.selected !== undefined) {
      page.selected = undefined
      this.ports.transcripts.release(page.owner, generation)
    }
    this.ports.observation.release(page.owner, generation)
  }

  private listen(page: CompanionPage, listener: CompanionEventListener): Disposer {
    page.listeners.add(listener)
    return () => {
      page.listeners.delete(listener)
    }
  }

  private emit(page: CompanionPage, event: CompanionEvent): void {
    for (const listener of [...page.listeners]) listener(event)
  }

  private page(pageId: string): CompanionPage {
    const page = this.pages.get(pageId)
    if (page === undefined) throw new Error('Companion page is not open')
    return page
  }

  private selected(pageId: string): CompanionPage {
    const page = this.page(pageId)
    if (page.selected === undefined) throw new Error('Companion page has no selection')
    return page
  }
}
