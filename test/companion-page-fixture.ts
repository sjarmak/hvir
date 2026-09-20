/**
 * A fake Companion listener behind the page's fetch port: routes, bodies and
 * one event stream the test drives by hand.
 */
import {
  COMPANION_PAGE_HEADER,
  type CompanionFetch,
  type CompanionRequestInit,
  type CompanionResponse,
} from '../src/renderer/companion/src/companion-client'
import type {
  CompanionCellSize,
  CompanionTerminalPane,
  CompanionTerminalPaneFactory,
} from '../src/renderer/companion/src/companion-terminal-pane'
import { COMPANION_DEFAULT_TEXT_SIZE } from '../src/renderer/companion/src/companion-text-size'
import {
  SESSIONS_COMPANION_VERSION,
  SESSIONS_TRANSCRIPT_VERSION,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  type CompanionRow,
  type CompanionSnapshot,
  type SessionsMutationResponse,
  type SessionsTranscriptSnapshot,
  type TerminalWheelEvent,
} from '../src/shared'

export interface FakeCall {
  readonly url: string
  readonly method: string
  readonly authorization?: string
  readonly body?: unknown
}

type Unbranded<T> = Omit<Partial<T>, 'handle'> & { readonly handle: string }

export function row(overrides: Unbranded<CompanionRow>): CompanionRow {
  return {
    title: overrides.handle,
    project: { handle: asSessionsProjectHandle('p1'), name: 'hvir' },
    workspace: {
      handle: asSessionsWorkspaceHandle('w1'),
      name: 'main',
      hostLabel: 'Local',
      hostKind: 'local',
    },
    origin: { kind: 'external-agent', sourceId: 'gas-city', sourceName: 'gas city' },
    attention: { status: 'unsupported' },
    freshness: 'fresh',
    working: false,
    turn: { status: 'unsupported' },
    canAnswer: true,
    canMirror: false,
    ...overrides,
    handle: asSessionsTerminalHandle(overrides.handle),
  }
}

export function snapshot(
  revision: number,
  rows: readonly CompanionRow[],
  options: { readonly demandGeneration?: number } = {},
): CompanionSnapshot {
  return {
    version: SESSIONS_COMPANION_VERSION,
    revision,
    demandGeneration: options.demandGeneration ?? 1,
    away: false,
    rows,
  }
}

export function transcript(
  overrides: Unbranded<SessionsTranscriptSnapshot>,
): SessionsTranscriptSnapshot {
  return {
    version: SESSIONS_TRANSCRIPT_VERSION,
    demandGeneration: 1,
    revision: 1,
    status: 'ready',
    stream: 'live',
    turns: [],
    older: false,
    dropped: 0,
    ...overrides,
    handle: asSessionsTerminalHandle(overrides.handle),
  }
}

export class FakeCompanionServer {
  readonly calls: FakeCall[] = []
  token = 'tok-1'
  page = 'page-1'
  pairStatus = 200
  verbStatus = 200
  /** The status POST input answers; anything but 200 carries `inputError`. */
  inputStatus = 200
  inputError = 'Refused'
  /** The status POST viewport answers; anything but 200 is a hold that did not take. */
  viewportStatus = 200
  /** While true, select replies wait until `releaseSelect` is called. */
  holdSelect = false
  transcriptReply: SessionsTranscriptSnapshot = transcript({ handle: 'none' })
  mutationReply: SessionsMutationResponse = { outcome: 'accepted' }
  private controller?: ReadableStreamDefaultController<Uint8Array>
  private readonly encoder = new TextEncoder()
  private heldSelects: (() => void)[] = []

  readonly fetch: CompanionFetch = (url, init) => {
    const response = this.answer(url, init)
    if (this.holdSelect && url.endsWith('/select')) {
      return new Promise((resolve) => {
        this.heldSelects.push(() => resolve(response))
      })
    }
    return Promise.resolve(response)
  }

  streams(): number {
    return this.calls.filter((call) => call.url === '/api/events').length
  }

  inputs(): unknown[] {
    return this.calls
      .filter((call) => call.url.endsWith('/input'))
      .map((call) => call.body)
  }

  /** Every grid the page held the PTY at, in order (ADR-058). */
  viewports(): unknown[] {
    return this.calls
      .filter((call) => call.url.endsWith('/viewport'))
      .map((call) => call.body)
  }

  releaseSelect(): void {
    for (const release of this.heldSelects.splice(0)) release()
  }

  emit(event: string, data: unknown): void {
    if (!this.controller) throw new Error('no open event stream')
    this.controller.enqueue(
      this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    )
  }

  heartbeat(): void {
    this.controller?.enqueue(this.encoder.encode(': heartbeat\n\n'))
  }

  drop(): void {
    this.controller?.close()
    this.controller = undefined
  }

  private answer(url: string, init: CompanionRequestInit): CompanionResponse {
    this.calls.push({
      url,
      method: init.method,
      authorization: init.headers['authorization'],
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    })
    if (url === '/pair') {
      return this.pairStatus === 200
        ? json(200, { token: this.token })
        : json(this.pairStatus, { error: 'Pairing code rejected' })
    }
    if (init.headers['authorization'] !== `Bearer ${this.token}`) {
      return json(401, { error: 'Unauthorized' })
    }
    if (url === '/api/events') return this.openStream()
    if (this.verbStatus !== 200) return json(this.verbStatus, { error: 'Refused' })
    if (url.endsWith('/select') || url.endsWith('/resume')) {
      return json(200, this.transcriptReply)
    }
    if (url.endsWith('/viewport')) {
      return this.viewportStatus === 200
        ? json(200, { outcome: 'accepted' })
        : json(this.viewportStatus, { error: 'The mirrored terminal ended or changed' })
    }
    if (url.endsWith('/input')) {
      return this.inputStatus === 200
        ? json(200, { outcome: 'accepted' })
        : json(this.inputStatus, { error: this.inputError })
    }
    return json(200, this.mutationReply)
  }

  private openStream(): CompanionResponse {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
      },
      cancel: () => {
        this.controller = undefined
      },
    })
    return {
      status: 200,
      headers: {
        get: (name) => (name.toLowerCase() === COMPANION_PAGE_HEADER ? this.page : null),
      },
      body: stream,
      json: () => Promise.reject(new Error('event stream')),
    }
  }
}

/**
 * The fake grid's cell size at the default text size: happy-dom lays nothing
 * out, so the pane reports its own. Like the real emulator it reports a box
 * proportional to its font, so a page that steps the size (ADR-059) derives a
 * different grid here too.
 */
export const FAKE_CELL_WIDTH = 8
export const FAKE_CELL_HEIGHT = 16

/** A pane the page test drives by hand: records every call, emits key bytes. */
export class FakeCompanionPane implements CompanionTerminalPane {
  readonly writes: string[] = []
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }> = []
  readonly inputEnabled: boolean[] = []
  /** Gestures the mount routed here, already in the emulator's own pixels. */
  readonly gestures: TerminalWheelEvent[] = []
  /** What `scroll` answers: the pane's pixels the page's own scroller is left to take. */
  untaken = 0
  /** Which screen the emulator reports; the page never reads the screen's text. */
  alternateScreen = false
  /** Rows the viewport sits back from the newest output; the test drives it with `moveViewport`. */
  offset = 0
  /** Times the page asked for the live edge back. */
  returns = 0
  /** Times the mount said a finger lifted, which is when a banked fraction is dropped. */
  gestureEnds = 0
  /** Where a reflow at the next `resize` leaves a viewport it no longer reaches. */
  reflowOffset?: number
  mounted?: HTMLElement
  disposed = false
  /** Every text size the page gave this pane, in order (ADR-059). */
  readonly fontSizes: number[] = []
  private fontSize = COMPANION_DEFAULT_TEXT_SIZE
  private readonly listeners = new Set<(data: string, source: 'user') => void>()
  private readonly navigationListeners = new Set<(data: string) => void>()
  private readonly viewportListeners = new Set<(offset: number) => void>()

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {}

  readonly events = {
    onData: (listener: (data: string, source: 'user') => void) => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    },
    onNavigation: (listener: (data: string) => void) => {
      this.navigationListeners.add(listener)
      return () => {
        this.navigationListeners.delete(listener)
      }
    },
    onViewport: (listener: (offset: number) => void) => {
      this.viewportListeners.add(listener)
      return () => {
        this.viewportListeners.delete(listener)
      }
    },
  }

  /** How many listeners this pane is holding, so a mirror let go of can be proved silent. */
  viewportSubscriptions(): number {
    return this.viewportListeners.size
  }

  /** The emulator moving its own viewport, however it was moved. */
  moveViewport(offset: number): void {
    this.offset = offset
    for (const listener of this.viewportListeners) listener(offset)
  }

  mount(container: HTMLElement): void {
    this.mounted = container
    const surface = document.createElement('div')
    surface.className = 'fake-pane'
    Object.defineProperty(surface, 'offsetWidth', {
      get: () => (this.resizes.at(-1)?.cols ?? this.cols) * this.cell().width,
    })
    Object.defineProperty(surface, 'offsetHeight', {
      get: () => (this.resizes.at(-1)?.rows ?? this.rows) * this.cell().height,
    })
    container.append(surface)
  }

  write(data: string): void {
    this.writes.push(data)
  }

  /**
   * Like the real pane: a reflow leaves the viewport where it was unless the
   * shortened scrollback no longer reaches it, and then re-anchors it to the
   * oldest row that is left. Only ever toward the live edge, which is the only
   * direction `anchorViewport` can move a viewport.
   */
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
    const reflowed = this.reflowOffset
    if (reflowed !== undefined && reflowed < this.offset) this.moveViewport(reflowed)
  }

  scroll(event: TerminalWheelEvent): number {
    this.gestures.push(event)
    return this.untaken
  }

  isAlternateScreen(): boolean {
    return this.alternateScreen
  }

  endGesture(): void {
    this.gestureEnds += 1
  }

  returnToLive(): void {
    this.returns += 1
    this.moveViewport(0)
  }

  /** Like the real pane: the font decides the cell, read live off the emulator. */
  setFontSize(size: number): void {
    this.fontSize = size
    this.fontSizes.push(size)
  }

  /** Like the real pane: no cell metrics until the emulator is mounted. */
  cellSize(): CompanionCellSize | undefined {
    if (this.mounted === undefined) return undefined
    return this.cell()
  }

  private cell(): CompanionCellSize {
    const scale = this.fontSize / COMPANION_DEFAULT_TEXT_SIZE
    return { width: FAKE_CELL_WIDTH * scale, height: FAKE_CELL_HEIGHT * scale }
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled.push(enabled)
  }

  /** The port's contract: a disposed pane holds on to nobody's subscription. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.navigationListeners.clear()
    this.viewportListeners.clear()
  }

  emitData(data: string): void {
    for (const listener of this.listeners) listener(data, 'user')
  }

  /** A read-back gesture's page key, which the real pane emits past the arm (ADR-055). */
  emitNavigation(data: string): void {
    for (const listener of this.navigationListeners) listener(data)
  }
}

export function fakePaneFactory(): {
  readonly createPane: CompanionTerminalPaneFactory
  readonly panes: FakeCompanionPane[]
} {
  const panes: FakeCompanionPane[] = []
  return {
    panes,
    createPane: (cols, rows) => {
      const pane = new FakeCompanionPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    },
  }
}

function json(status: number, body: unknown): CompanionResponse {
  return {
    status,
    headers: { get: () => null },
    body: null,
    json: () => Promise.resolve(body),
  }
}
