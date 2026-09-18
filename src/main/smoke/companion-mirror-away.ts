/**
 * A prompt submitted from a Companion mirror while Away (ADR-050
 * Consequences): with the desktop window hidden and background-throttled, the
 * phone's Enter must still arm Ready detection in the renderer, so the next
 * quiet period reaches main's set as Ready within the ADR-049 budget and
 * produces exactly one Push whose text carries none of the typed bytes.
 */

import { isCompanionSnapshot } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { RendererEventPublisher } from '../renderer-event-publisher'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { installMirrorInputNotice } from '../terminal/mirror-input-notice'
import {
  formatAwayReadyMeasurement,
  judgeAwayReadyMeasurement,
  parseAwayHiddenHoldMs,
  type AwayReadyMeasurement,
} from './attention-away-policy'
import { rendererFocusState, waitFor, waitForReady } from './attention-away-probe'
import {
  applyAwayState,
  clearTerminalAttention,
  restoreWindow,
  withWindowRestored,
} from './attention-away-window'
import {
  disableListener,
  enableAndPair,
  retainedSmokeSession,
  SMOKE_PUSH_URL,
  type CompanionAwayOptions,
} from './companion-away-pairing'
import { openEventFrames, type CompanionEventFrames } from './companion-events'
import { expectStatus, send } from './companion-http'
import type { SmokeCompanion } from './companion-smoke'
import { prepareTerminalScenario } from './terminal-scenario-ready'

const MIRROR_SMOKE_TITLE = 'Companion mirror smoke'
const STEP_TIMEOUT_MS = 10_000
/** The line the phone submits: the shell runs it and goes quiet at its prompt. */
const MIRROR_PROMPT = "printf '\\r\\nmirror-done\\r\\n'\r"
const MIRROR_BYTE_MARKERS = ['mirror-done', 'printf'] as const

export async function verifyCompanionMirrorAwayScenario(
  options: CompanionAwayOptions,
): Promise<string> {
  const { win, supervisor, attention, resources, companion } = options
  await prepareTerminalScenario(win, supervisor)
  const terminal = supervisor.list()[0]
  if (!terminal) throw new Error('mirror away scenario has no terminal to mirror')
  options.addRetained(
    options.smokeRoot,
    retainedSmokeSession(terminal, options.smokeRoot, MIRROR_SMOKE_TITLE),
  )
  const owner = resources.currentOwner(win.webContents.id)
  const onFocus = (): void => attention.setOwnerFocused(owner, true)
  const onBlur = (): void => attention.setOwnerFocused(owner, false)
  win.on('focus', onFocus)
  win.on('blur', onBlur)
  attention.setOwnerFocused(owner, win.isFocused())
  const notice = installSmokeMirrorInputNotice(supervisor, resources)
  let openFrames: CompanionEventFrames | undefined
  return withWindowRestored(win, async () => {
    try {
      const { port, bearer } = await enableAndPair(companion)
      console.log(`[smoke] mirror away paired on port ${port}`)
      const frames = await openEventFrames(port, bearer)
      openFrames = frames
      console.log(`[smoke] mirror away page ${frames.pageId} streaming`)
      await selectMirror(frames, port, bearer, terminal.id)
      console.log('[smoke] mirror away mirror opened at the desktop geometry')
      const measurement = await submitFromMirrorWhileHidden(options, frames, terminal.id, {
        port,
        bearer,
      })
      console.log(`[smoke] mirror away ready ${formatAwayReadyMeasurement(measurement)}`)
      const failure = judgeAwayReadyMeasurement(measurement)
      if (failure) throw new Error(`mirror away: ${failure}`)

      await verifyOnePush(companion)
      console.log('[smoke] mirror away one push without mirror bytes')
      await verifyRevocationOrder(companion, frames, terminal.id)
      await disableListener(companion)
      return `port ${port}, ${formatAwayReadyMeasurement(measurement)}, one push without mirror bytes, ended revoked before closed`
    } finally {
      openFrames?.close()
      await notice.dispose()
      win.removeListener('focus', onFocus)
      win.removeListener('blur', onBlur)
    }
  })
}

/**
 * Clears the terminal's attention at the desk, hides the window, holds, then
 * submits the prompt through the mirror and measures quiet-to-Ready in main.
 */
async function submitFromMirrorWhileHidden(
  { win, attention }: CompanionAwayOptions,
  frames: CompanionEventFrames,
  terminalId: string,
  listener: { readonly port: number; readonly bearer: Record<string, string> },
): Promise<AwayReadyMeasurement> {
  await restoreWindow(win)
  await clearTerminalAttention(win, attention, terminalId)
  const holdMs = parseAwayHiddenHoldMs(process.env.HVIR_SMOKE_AWAY_HIDDEN_HOLD_MS)
  const honored = await applyAwayState(win, 'hidden')
  await waitFor(() => false, holdMs)

  const sentAt = Date.now()
  const accepted = await send(listener.port, 'POST', route(terminalId, 'input'), {
    headers: listener.bearer,
    body: { page: frames.pageId, data: MIRROR_PROMPT },
  })
  expectStatus(accepted, 200, 'POST input')
  await waitFor(
    () => frames.lastOutputAt() >= sentAt,
    STEP_TIMEOUT_MS,
    'mirror away: no mirror output followed the phone input',
  )
  const readyAt = await waitForReady(attention, terminalId)
  const renderer = await rendererFocusState(win)
  return {
    state: 'hidden',
    honored,
    quietToReadyMs: readyAt - frames.lastOutputAt(),
    holdMs,
    visibility: renderer.visibility,
    rendererFocused: renderer.focused,
    minimized: win.isMinimized(),
    away: attention.set.away(),
  }
}

/**
 * The production notice over the production publisher: the smoke window is a
 * BrowserWindow, so the same `isCurrent` owner gate and delivery edge apply.
 */
function installSmokeMirrorInputNotice(
  supervisor: PtySupervisor,
  resources: Pick<RendererResourceScopes, 'isCurrent'>,
): { dispose: () => Promise<void> } {
  const disposers: Array<() => void | Promise<void>> = []
  installMirrorInputNotice(
    {
      own: (_label, resource, dispose) => {
        disposers.push(() => dispose(resource))
        return resource
      },
    },
    supervisor,
    new RendererEventPublisher(resources),
  )
  return {
    dispose: async () => {
      for (const dispose of disposers.splice(0)) await dispose()
    },
  }
}

/** Waits for the live row, selects it, and waits for the mirror to open at a real geometry. */
async function selectMirror(
  frames: CompanionEventFrames,
  port: number,
  bearer: Record<string, string>,
  terminalId: string,
): Promise<void> {
  await frames.waitFor(
    'snapshot',
    (data) =>
      isCompanionSnapshot(data) &&
      data.rows.some((row) => row.handle === terminalId && row.canMirror),
    STEP_TIMEOUT_MS,
    'carrying the mirrorable terminal row',
  )
  const selected = await send(port, 'POST', route(terminalId, 'select'), {
    headers: bearer,
    body: { page: frames.pageId },
  })
  expectStatus(selected, 200, 'POST select')
  await frames.waitFor(
    'terminal',
    (data) => {
      const frame = terminalFrame(data)
      return (
        frame?.type === 'opened' &&
        frame.handle === terminalId &&
        isPositiveInteger(frame.cols) &&
        isPositiveInteger(frame.rows)
      )
    },
    STEP_TIMEOUT_MS,
    'opening the mirror at the desktop geometry',
  )
}

/** Exactly one Push goes out for the Ready, naming project and title, never the typed bytes. */
async function verifyOnePush(companion: SmokeCompanion): Promise<void> {
  await waitFor(() => companion.pushes.length >= 1, STEP_TIMEOUT_MS, 'mirror away: no Push')
  if (companion.pushes.length !== 1) {
    throw new Error(`mirror away: expected one Push, saw ${companion.pushes.length}`)
  }
  const push = companion.pushes[0]!
  if (push.url !== SMOKE_PUSH_URL) throw new Error(`mirror away: Push went to ${push.url}`)
  if (!push.body.includes(MIRROR_SMOKE_TITLE)) {
    throw new Error('mirror away: the Push body does not name the mirrored terminal')
  }
  for (const marker of MIRROR_BYTE_MARKERS) {
    if (push.body.includes(marker)) {
      throw new Error(`mirror away: the Push body carries mirror bytes (${marker})`)
    }
  }
  const unexpected = companion.diagnostics.filter(
    (diagnostic) =>
      diagnostic.kind === 'push-outcome' ||
      diagnostic.kind === 'listener-failed' ||
      diagnostic.kind === 'request-failure',
  )
  if (unexpected.length > 0) {
    throw new Error(`mirror away: Companion diagnostics ${JSON.stringify(unexpected)}`)
  }
}

/** Revocation ends the mirror before it closes the page, in that order on the stream. */
async function verifyRevocationOrder(
  companion: SmokeCompanion,
  frames: CompanionEventFrames,
  terminalId: string,
): Promise<void> {
  await companion.settings.revokePairing()
  await frames.waitFor('closed', () => true, STEP_TIMEOUT_MS, 'after revoke')
  await frames.waitFor(
    'terminal',
    (data) => {
      const frame = terminalFrame(data)
      return frame?.type === 'ended' && frame.handle === terminalId && frame.reason === 'revoked'
    },
    STEP_TIMEOUT_MS,
    'ended revoked',
  )
  const sequence = frames.sequence()
  const ended = sequence.indexOf('terminal:ended')
  const closed = sequence.indexOf('closed')
  if (ended === -1 || closed === -1 || ended > closed) {
    throw new Error(`mirror away: revoke order was ${sequence.join(' ')}`)
  }
}

function route(terminalId: string, verb: string): string {
  return `/api/sessions/${encodeURIComponent(terminalId)}/${verb}`
}

interface TerminalFrameShape {
  readonly type: string
  readonly handle: string
  readonly cols?: unknown
  readonly rows?: unknown
  readonly reason?: unknown
}

function terminalFrame(data: unknown): TerminalFrameShape | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  if (typeof record['type'] !== 'string' || typeof record['handle'] !== 'string') {
    return undefined
  }
  return record as unknown as TerminalFrameShape
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
