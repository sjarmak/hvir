import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'
import type { AwayWindowState } from './attention-away-policy'
import { waitFor } from './attention-away-probe'

export type MeasuredTerminal = { readonly id: string; readonly ownerId: number }

/**
 * Arms the renderer (Enter while focused) and leaves the shell waiting for a
 * main-side burst: the burst and the prompt after it are the last output before
 * the quiet period, so the newest PTY data time is the quiet-period start.
 */
export async function armAwayTerminal(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  terminal: MeasuredTerminal,
  state: AwayWindowState,
): Promise<{
  lastOutputAt: () => number
  burst: () => Promise<void>
  detach: () => void | Promise<void>
}> {
  let output = ''
  let lastOutputAt = 0
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      lastOutputAt = Date.now()
      output = (output + data).slice(-16_384)
    },
  })
  const marker = (step: string): string =>
    `printf '\\r\\naway-${step}:%s\\r\\n' ${JSON.stringify(state)}`
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    `stty -echo; ${marker('armed')}; IFS= read -r hvir_go; ${marker('go')}; IFS= read -r hvir_burst; stty echo; ${marker('burst')}\n`,
  )
  await waitFor(
    () => output.includes(`away-armed:${state}`),
    10_000,
    `away throttling: ${state} shell did not become input-ready: ${JSON.stringify(output)}`,
  )
  for (const type of ['keyDown', 'keyUp'] as const) {
    win.webContents.sendInputEvent({ type, keyCode: 'Enter' })
  }
  await waitFor(
    () => output.includes(`away-go:${state}`),
    10_000,
    `away throttling: ${state} Enter did not reach the shell: ${JSON.stringify(output)}`,
  )
  const burst = async (): Promise<void> => {
    supervisor.write(terminal.id, terminal.ownerId, '\n')
    await waitFor(
      () => output.includes(`away-burst:${state}`),
      10_000,
      `away throttling: ${state} burst never printed: ${JSON.stringify(output)}`,
    )
  }
  return { lastOutputAt: () => lastOutputAt, burst, detach }
}
