/**
 * The Companion's Sessions verbs (ADR-049, ADR-050): open a page, read its
 * rows, select a row's transcript and mirror, answer, message, type, close.
 *
 * Every open page holds one observation lease under a companion owner the
 * service mints (page id plus a service-wide generation), at most one
 * transcript lease under the same owner, and at most one mirror lease on the
 * live PTY instance behind the selected row. The service registers the one
 * companion sink and routes each change to the page whose owner and generation
 * it names. No page open means no lease held and no source subscribed: the
 * Companion is quiet when hidden. It never resolves an open, never attaches as
 * a renderer, never asks for usage; those are renderer verbs the ports refuse
 * it anyway. Mirror bytes pass through the service and never into a message.
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
import { companionMirrorTarget } from './companion-mirror-target'
import { CompanionPageMirror, type CompanionMirrorAttach } from './companion-page-mirror'
import { companionRows } from './companion-rows'

/** What a phone's bytes are: the person typing, or a read-back gesture paging (ADR-055). */
export type CompanionInputKind = 'typing' | 'navigation'

/** The PTY supervisor's mirror door and the Settings permission, as ports. */
export interface CompanionMirrorPorts {
  readonly attach: CompanionMirrorAttach
  readonly typingAllowed: () => boolean
}

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
  readonly mirrors: CompanionMirrorPorts
  /** Page ids are random by default; a test names them. */
  readonly mintPageId?: () => string
}

export type CompanionEventListener = (event: CompanionEvent) => void

/** A verb named a page this service does not hold. */
export class CompanionPageNotOpenError extends Error {
  constructor() {
    super('Companion page is not open')
    this.name = 'CompanionPageNotOpenError'
  }
}

/** A transcript verb arrived before the page selected a row. */
export class CompanionNoSelectionError extends Error {
  constructor() {
    super('Companion page has no selection')
    this.name = 'CompanionNoSelectionError'
  }
}

/** Input arrived while Settings does not allow typing from the Companion. */
export class CompanionTypingDisallowedError extends Error {
  constructor() {
    super('Typing from the Companion is off in Settings')
    this.name = 'CompanionTypingDisallowedError'
  }
}

/** Input named a row this page holds no mirror for. */
export class CompanionNoMirrorError extends Error {
  constructor() {
    super('Companion page holds no mirror for this row')
    this.name = 'CompanionNoMirrorError'
  }
}

export interface CompanionOpenPage {
  readonly pageId: string
  readonly snapshot: CompanionSnapshot
  readonly events: (listener: CompanionEventListener) => Disposer
}

interface CompanionPage {
  readonly id: string
  readonly owner: SessionsCompanionDemandOwner
  readonly listeners: Set<CompanionEventListener>
  readonly mirror: CompanionPageMirror
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
      mirror: new CompanionPageMirror(this.ports.mirrors.attach, (terminal) =>
        this.emit(page, { type: 'terminal', terminal }),
      ),
      fingerprint: '',
      snapshot: {
        version: SESSIONS_COMPANION_VERSION,
        revision: 0,
        demandGeneration: generation,
        away: this.ports.actionable.snapshot().away,
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
    const target = companionMirrorTarget(observed, handle)
    if (target === undefined) page.mirror.end('reselected')
    else page.mirror.open(handle, target)
    return snapshot
  }

  /**
   * The user's exact bytes to the mirrored row; refused before the lease is
   * asked. `navigation` is a read-back gesture paging a program through its own
   * history (ADR-055): the owner's permission gates it the same way, and it
   * reaches the PTY without being recorded as terminal input. The page's
   * per-mirror arm, which typing also passes, is the page's own gate and was
   * never this one.
   */
  input(
    pageId: string,
    handle: SessionsTerminalHandle,
    data: string,
    kind: CompanionInputKind = 'typing',
  ): void {
    const page = this.page(pageId)
    if (!this.ports.mirrors.typingAllowed()) throw new CompanionTypingDisallowedError()
    if (page.mirror.handle !== handle) throw new CompanionNoMirrorError()
    if (kind === 'navigation') page.mirror.navigate(data)
    else page.mirror.write(data)
  }

  /**
   * The grid the page is drawing (ADR-058). Watching is not typing, so the Settings gate
   * that guards input never applies here; a page may size what it reads without being
   * allowed to write to it.
   */
  viewport(
    pageId: string,
    handle: SessionsTerminalHandle,
    cols: number,
    rows: number,
  ): void {
    const page = this.page(pageId)
    if (page.mirror.handle !== handle) throw new CompanionNoMirrorError()
    page.mirror.viewport(cols, rows)
  }

  /** The stream fell behind: the route ends the mirror rather than the page. */
  endMirror(pageId: string, reason: 'overrun'): void {
    this.pages.get(pageId)?.mirror.end(reason)
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
    for (const page of pages) this.close(page, reason)
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
      this.close(page, 'lease-lost')
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

  /** Rows and Away are what a page sees; a change to either is a new revision. */
  private refresh(page: CompanionPage, observed: SessionsObservationSnapshot): boolean {
    const actionable = this.ports.actionable.snapshot()
    const rows = companionRows({
      observation: observed,
      actionable: actionable.entries,
      working: actionable.working,
      resolveExternal: (handle) => this.resolveExternal(page, handle),
    })
    const { away } = actionable
    const fingerprint = JSON.stringify({ away, rows })
    if (fingerprint === page.fingerprint) return false
    page.fingerprint = fingerprint
    page.snapshot = {
      version: SESSIONS_COMPANION_VERSION,
      revision: page.snapshot.revision + 1,
      demandGeneration: page.owner.generation,
      away,
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

  /** The mirror ends first so its `ended` precedes the page's `closed`. */
  private close(page: CompanionPage, reason: CompanionClosedReason): void {
    page.mirror.end(reason)
    this.emit(page, { type: 'closed', reason })
  }

  private releaseLeases(page: CompanionPage): void {
    const { generation } = page.owner
    page.mirror.end('page-closed')
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
    if (page === undefined) throw new CompanionPageNotOpenError()
    return page
  }

  private selected(pageId: string): CompanionPage {
    const page = this.page(pageId)
    if (page.selected === undefined) throw new CompanionNoSelectionError()
    return page
  }
}
