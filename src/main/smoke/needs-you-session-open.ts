import { app, type BrowserWindow } from 'electron'
import type { PtySupervisor } from '../pty/pty-supervisor'

const STEP_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 25
const ACTIVE_PROJECT = `document.querySelector('.project-tab.active .project-tab-main strong')?.textContent?.trim()`

interface SessionOpenOrigin {
  readonly sessionId: string | null
  readonly project: string | null
}

export async function verifyNeedsYouSessionOpen(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  if (!win.isVisible()) win.show()
  app.focus({ steal: true })
  win.focus()
  win.webContents.focus()
  const origin = (await win.webContents.executeJavaScript(`(() => {
    const surface = [...document.querySelectorAll('.workbench .terminal-surface')]
      .find((candidate) =>
        (candidate.getAttribute('data-terminal-status') || '').startsWith('pid '));
    return {
      sessionId: surface?.getAttribute('data-terminal-session') ?? null,
      project: ${ACTIVE_PROJECT} ?? null,
    };
  })()`)) as SessionOpenOrigin
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.id === origin.sessionId)
  if (!terminal || !origin.project) {
    throw new Error('Needs you session open smoke lacked a live workspace terminal')
  }
  const project = JSON.stringify(origin.project)
  const surface = `document.querySelector('.workbench .terminal-surface[data-terminal-session="' + CSS.escape(${JSON.stringify(terminal.id)}) + '"]')`
  const row = `[...document.querySelectorAll('.needs-you-list li')].find((item) =>
    item.querySelector('.needs-you-reason')?.textContent?.trim() === 'Bell' &&
    item.querySelector('.needs-you-context')?.textContent?.startsWith(${project} + ' / ') &&
    item.querySelector('.needs-you-action')?.textContent?.trim() === 'View session'
  )?.querySelector('button')`

  await clickWhenReady(
    win,
    'Needs you destination',
    `[...document.querySelectorAll('.sessions-destination')]
      .find((candidate) => candidate.textContent?.trim() === 'Needs you')`,
  )
  await waitFor(
    win,
    'Needs you entry',
    `Boolean(document.querySelector('.needs-you-view'))`,
  )
  supervisor.write(terminal.id, terminal.ownerId, "printf '\\007'\n")
  await clickWhenReady(win, 'session row', row)
  await waitFor(
    win,
    'exact terminal focus',
    `(() => {
      const surface = ${surface};
      const engine = surface?.querySelector('.terminal-engine-host');
      const workbench = document.querySelector('.workbench');
      return !document.querySelector('.needs-you-view') &&
        !document.querySelector('.sessions-overview') &&
        workbench instanceof HTMLElement && !workbench.hidden &&
        ${ACTIVE_PROJECT} === ${project} &&
        surface?.classList.contains('active') &&
        engine instanceof HTMLElement &&
        (document.activeElement === engine || engine.contains(document.activeElement));
    })()`,
  )
  return 'Needs you View session focuses the exact workspace terminal'
}

async function clickWhenReady(
  win: BrowserWindow,
  stage: string,
  target: string,
): Promise<void> {
  await waitFor(
    win,
    stage,
    `(() => {
      const button = ${target};
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
  )
}

async function waitFor(
  win: BrowserWindow,
  stage: string,
  condition: string,
): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${condition})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  const state = (await win.webContents.executeJavaScript(`JSON.stringify({
    project: ${ACTIVE_PROJECT},
    focused: document.hasFocus(),
    needsYou: Boolean(document.querySelector('.needs-you-view')),
    sessions: Boolean(document.querySelector('.sessions-overview')),
    rows: [...document.querySelectorAll('.needs-you-list li')]
      .map((item) => item.textContent?.trim().slice(0, 120)),
    status: document.querySelector('.needs-you-view [role=status]')?.textContent?.trim()
  })`)) as string
  throw new Error(`Needs you session open smoke timed out at ${stage}: ${state}`)
}
