/**
 * A terminal notification while Away (ADR-051): with the desktop window hidden
 * and background-throttled, an OSC 9 the shell writes must reach main's set as
 * a prompt entry carrying its message at once, with no Enter arming and no
 * quiet wait; the Companion row must carry the same message, and the one Push
 * must carry it as its line.
 */

import { isCompanionSnapshot } from '../../shared'
import type { ManagedPty } from '../pty/pty-contract'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { AWAY_PROMPT_BUDGET_MS, parseAwayHiddenHoldMs } from './attention-away-policy'
import {
  rendererFocusState,
  waitFor,
  waitForActionable,
  type ActionableArrival,
} from './attention-away-probe'
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
import type { SmokeCompanion } from './companion-smoke'
import { prepareTerminalScenario } from './terminal-scenario-ready'

const PROMPT_SMOKE_TITLE = 'Companion prompt smoke'
const STEP_TIMEOUT_MS = 10_000
/** The message the notification carries; the surfaces must show it verbatim. */
const PROMPT_BODY = 'away-prompt: approve the smoke step'
/**
 * The bytes printf emits, as Claude Code writes them (ESC ] 9 ; body BEL).
 * The typed command holds the escapes as backslash text, so its echo can
 * never contain this sequence; only the running printf can.
 */
const OSC_9_BYTES = `\x1b]9;${PROMPT_BODY}\x07`

interface PromptMeasurement {
  /** From main seeing the notification bytes to the prompt entry in main's set. */
  readonly notifyToPromptMs: number
  readonly visibility: string
  readonly rendererFocused: boolean
  readonly away: boolean
  readonly entry: ActionableArrival['entry']
}

export async function verifyCompanionPromptAwayScenario(
  options: CompanionAwayOptions,
): Promise<string> {
  const { win, supervisor, attention, resources, companion } = options
  await prepareTerminalScenario(win, supervisor)
  const terminal = supervisor.list()[0]
  if (!terminal) throw new Error('prompt away scenario has no terminal to notify from')
  options.addRetained(
    options.smokeRoot,
    retainedSmokeSession(terminal, options.smokeRoot, PROMPT_SMOKE_TITLE),
  )
  const owner = resources.currentOwner(win.webContents.id)
  const onFocus = (): void => attention.setOwnerFocused(owner, true)
  const onBlur = (): void => attention.setOwnerFocused(owner, false)
  win.on('focus', onFocus)
  win.on('blur', onBlur)
  attention.setOwnerFocused(owner, win.isFocused())
  let openFrames: CompanionEventFrames | undefined
  return withWindowRestored(win, async () => {
    try {
      const { port, bearer } = await enableAndPair(companion)
      console.log(`[smoke] prompt away paired on port ${port}`)
      const frames = await openEventFrames(port, bearer)
      openFrames = frames
      await waitForRow(frames, terminal.id)
      const measurement = await notifyWhileHidden(options, terminal)
      console.log(`[smoke] prompt away ${formatPromptMeasurement(measurement)}`)
      const failure = judgePromptMeasurement(measurement)
      if (failure) throw new Error(`prompt away: ${failure}`)
      await waitForPromptRow(frames, terminal.id)
      console.log('[smoke] prompt away Companion row carries the message')
      await verifyPromptPush(companion)
      console.log('[smoke] prompt away one push carrying the message as its line')
      await disableListener(companion)
      return `port ${port}, ${formatPromptMeasurement(measurement)}, on the Companion row, one push with the line`
    } finally {
      openFrames?.close()
      win.removeListener('focus', onFocus)
      win.removeListener('blur', onBlur)
    }
  })
}

/**
 * Clears the terminal's attention at the desk, hides the window, holds, then
 * has the shell print the notification and measures its arrival in main.
 */
async function notifyWhileHidden(
  { win, supervisor, attention }: CompanionAwayOptions,
  terminal: ManagedPty,
): Promise<PromptMeasurement> {
  await restoreWindow(win)
  await clearTerminalAttention(win, attention, terminal.id)
  const holdMs = parseAwayHiddenHoldMs(process.env.HVIR_SMOKE_AWAY_HIDDEN_HOLD_MS)
  await applyAwayState(win, 'hidden')
  await waitFor(() => false, holdMs)

  const notifiedAt = await printNotification(supervisor, terminal)
  const arrival = await waitForActionable(attention, terminal.id, 'prompt', STEP_TIMEOUT_MS)
  const renderer = await rendererFocusState(win)
  return {
    notifyToPromptMs: arrival.at - notifiedAt,
    visibility: renderer.visibility,
    rendererFocused: renderer.focused,
    away: attention.set.away(),
    entry: arrival.entry,
  }
}

/**
 * Has the shell print the notification with echo off, and resolves when the
 * ESC ] 9 ; body BEL bytes themselves have left the PTY. The typed line is
 * echoed before the shell runs it, but that echo carries backslash text,
 * not the ESC and BEL bytes, so only printf's own output can match.
 */
async function printNotification(
  supervisor: PtySupervisor,
  terminal: ManagedPty,
): Promise<number> {
  let output = ''
  let notifiedAt = 0
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      output = (output + data).slice(-16_384)
      if (notifiedAt === 0 && output.includes(OSC_9_BYTES)) notifiedAt = Date.now()
    },
  })
  try {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      `stty -echo; printf '\\033]9;${PROMPT_BODY}\\007'; stty echo\n`,
    )
    await waitFor(
      () => notifiedAt !== 0,
      STEP_TIMEOUT_MS,
      'prompt away: the shell never printed the notification',
    )
  } finally {
    await detach()
  }
  return notifiedAt
}

function judgePromptMeasurement(measurement: PromptMeasurement): string | undefined {
  if (!measurement.away) return 'the prompt reached main while a window was focused'
  if (measurement.entry.body !== PROMPT_BODY) {
    return `the prompt entry carries ${JSON.stringify(measurement.entry.body)} instead of the message`
  }
  if (measurement.notifyToPromptMs > AWAY_PROMPT_BUDGET_MS) {
    return `the prompt reached main ${measurement.notifyToPromptMs}ms after the notification (budget ${AWAY_PROMPT_BUDGET_MS}ms)`
  }
  return undefined
}

function formatPromptMeasurement(measurement: PromptMeasurement): string {
  return (
    `hidden: notify->prompt ${measurement.notifyToPromptMs}ms with its message ` +
    `(visibility ${measurement.visibility}, renderer focused ${measurement.rendererFocused}, ` +
    `away ${measurement.away})`
  )
}

async function waitForRow(frames: CompanionEventFrames, terminalId: string): Promise<void> {
  await frames.waitFor(
    'snapshot',
    (data) => isCompanionSnapshot(data) && data.rows.some((row) => row.handle === terminalId),
    STEP_TIMEOUT_MS,
    'carrying the terminal row',
  )
}

/** The row reports the prompt with the same message main's set carries. */
async function waitForPromptRow(
  frames: CompanionEventFrames,
  terminalId: string,
): Promise<void> {
  await frames.waitFor(
    'snapshot',
    (data) =>
      isCompanionSnapshot(data) &&
      data.rows.some(
        (row) =>
          row.handle === terminalId &&
          row.attention.status === 'available' &&
          row.attention.value === 'prompt' &&
          row.promptBody === PROMPT_BODY,
      ),
    STEP_TIMEOUT_MS,
    'carrying the row as a prompt with its message',
  )
}

/** Exactly one Push goes out for the prompt: the title, then the message as its line. */
async function verifyPromptPush(companion: SmokeCompanion): Promise<void> {
  await waitFor(() => companion.pushes.length >= 1, STEP_TIMEOUT_MS, 'prompt away: no Push')
  if (companion.pushes.length !== 1) {
    throw new Error(`prompt away: expected one Push, saw ${companion.pushes.length}`)
  }
  const push = companion.pushes[0]!
  if (push.url !== SMOKE_PUSH_URL) throw new Error(`prompt away: Push went to ${push.url}`)
  const [pointer, line, ...rest] = push.body.split('\n')
  if (pointer === undefined || !pointer.includes(PROMPT_SMOKE_TITLE)) {
    throw new Error('prompt away: the Push body does not name the notified terminal')
  }
  if (line !== PROMPT_BODY || rest.length > 0) {
    throw new Error('prompt away: the Push line is not the prompt message')
  }
  const unexpected = companion.diagnostics.filter(
    (diagnostic) =>
      diagnostic.kind === 'push-outcome' ||
      diagnostic.kind === 'listener-failed' ||
      diagnostic.kind === 'request-failure',
  )
  if (unexpected.length > 0) {
    throw new Error(`prompt away: Companion diagnostics ${JSON.stringify(unexpected)}`)
  }
}
