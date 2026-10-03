import { BrowserWindow } from 'electron'
import { localPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { waitFor } from './attention-away-probe'
import { expectStatus, send } from './companion-http'
import type { SmokeCompanion } from './companion-smoke'

const TIMEOUT_MS = 15_000
const TOKEN_KEY = 'hvir-companion:token:v1'

export async function verifyCompanionSwitching(
  first: SmokeCompanion,
  host: Pick<ProjectHost, 'writeFile'>,
): Promise<void> {
  const second = await first.createSibling()
  const win = new BrowserWindow({
    width: 375,
    height: 812,
    show: false,
    webPreferences: {
      partition: `companion-switching-${crypto.randomUUID()}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  try {
    await second.settings.save({ enabled: true, port: 0, mirrorInputAllowed: false })
    await waitFor(() => second.server.listening, TIMEOUT_MS, 'second Companion listener')
    const firstUrl = endpoint(first)
    const secondUrl = endpoint(second)
    await win.loadURL(firstUrl)
    await pair(win, first)
    await saveLink(win, 'Other computer', secondUrl)
    await captureLayouts(win, host)
    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
      win.reload()
    })
    await ready(win, `Boolean(document.querySelector('.companion-instance-links a'))`)
    const firstToken = await token(win)
    await openLink(win, 'Other computer', secondUrl)
    await ready(win, `Boolean(document.querySelector('#companion-pair-code'))`)
    if (await token(win)) throw new Error('Pairing credential crossed Companion origins')
    await released(first)
    if (second.sessions.openPages !== 0)
      throw new Error('Unpaired destination opened a session page')
    const crossOrigin = await send(second.server.port!, 'GET', '/api/sessions?page=x', {
      headers: { authorization: `Bearer ${firstToken}` },
    })
    expectStatus(crossOrigin, 401, 'Other-instance pairing credential')
    await pair(win, second)
    const secondToken = await token(win)
    if (!secondToken || secondToken === firstToken)
      throw new Error('Companion instances did not establish independent pairings')
    await saveLink(win, 'First computer', firstUrl)
    await assertPhoneLayout(win)
    win.webContents.navigationHistory.goBack()
    await waitFor(
      () => win.webContents.getURL() === firstUrl,
      TIMEOUT_MS,
      'browser Back to first Companion',
    )
    await ready(win, `Boolean(document.querySelector('.companion-instance-links a'))`)
    await released(second)
    await openLink(win, 'Other computer', secondUrl)
    await ready(win, `Boolean(document.querySelector('.companion-instance-links a'))`)
    await openLink(win, 'First computer', firstUrl)
    await ready(win, `!document.querySelector('#companion-pair-code')`)
    if ((await token(win)) !== firstToken)
      throw new Error('Returning to first instance lost its own pairing')
    await released(second)
    await ready(win, `Boolean(document.querySelector('.companion-instance-links a'))`)
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))`,
    )
    await released(first)
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`,
    )
    await ready(win, `Boolean(document.querySelector('.companion-disconnected'))`)
    await clickButton(win, 'Reconnect')
    await waitFor(
      () => first.server.openStreams === 1,
      TIMEOUT_MS,
      'explicit phone reconnect',
    )
    win.destroy()
    await released(first)
    const unexpected = second.diagnostics.filter(
      (item) => item.kind === 'listener-failed' || item.kind === 'request-failure',
    )
    if (unexpected.length) throw new Error('Second Companion reported owner failures')
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await second.settings.save({ enabled: false, port: 0, mirrorInputAllowed: false })
  }
}

function endpoint(companion: SmokeCompanion): string {
  if (companion.server.port === undefined) throw new Error('Companion has no bound port')
  return `http://127.0.0.1:${companion.server.port}/`
}

async function pair(win: BrowserWindow, companion: SmokeCompanion): Promise<void> {
  await ready(win, `Boolean(document.querySelector('#companion-pair-code'))`)
  const code = companion.settings.issuePairing().pairing?.code
  if (!code) throw new Error('Companion did not issue a pairing code')
  await fill(win, '#companion-pair-code', code)
  await clickButton(win, 'Pair')
  await waitFor(
    () => companion.server.openStreams === 1,
    TIMEOUT_MS,
    'paired phone stream',
  )
  await ready(win, `!document.querySelector('#companion-pair-code')`)
}

async function saveLink(win: BrowserWindow, name: string, url: string): Promise<void> {
  await ready(
    win,
    `Boolean(document.querySelector('.companion-instance-switcher summary'))`,
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('.companion-instance-switcher details').open = true`,
  )
  await fill(win, '#companion-instance-name', name)
  await fill(win, '[aria-label="Companion endpoint URL"]', url)
  await clickButton(win, 'Save')
  await ready(
    win,
    `[...document.querySelectorAll('.companion-instance-links a')].some(link => link.href === ${JSON.stringify(url)})`,
  )
}

async function openLink(win: BrowserWindow, name: string, url: string): Promise<void> {
  const selector = `([...document.querySelectorAll('.companion-instance-link')].find(row => row.textContent.includes(${JSON.stringify(name)}))?.querySelector('a'))`
  await win.webContents.executeJavaScript(
    `document.querySelector('.companion-instance-switcher details').open = true`,
  )
  await ready(win, `Boolean(${selector})`)
  await win.webContents.executeJavaScript(`${selector}.click()`, true)
  await waitFor(
    () => win.webContents.getURL() === url,
    TIMEOUT_MS,
    'Companion destination navigation',
  )
  await ready(win, `Boolean(document.querySelector('.companion-instance-switcher'))`)
}

async function token(win: BrowserWindow): Promise<string | null> {
  return (await win.webContents.executeJavaScript(
    `localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`,
  )) as string | null
}

async function released(companion: SmokeCompanion): Promise<void> {
  await waitFor(
    () => companion.server.openStreams === 0 && companion.sessions.openPages === 0,
    TIMEOUT_MS,
    'old Companion stream and demand release',
  )
}

async function fill(win: BrowserWindow, selector: string, value: string): Promise<void> {
  await ready(win, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
}

async function clickButton(win: BrowserWindow, label: string): Promise<void> {
  const selector = `([...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}))`
  await ready(win, `${selector} && !${selector}.disabled`)
  await win.webContents.executeJavaScript(`${selector}.click()`, true)
}

async function assertPhoneLayout(win: BrowserWindow): Promise<void> {
  const fits = (await win.webContents.executeJavaScript(
    `document.documentElement.scrollWidth <= window.innerWidth &&
    [...document.querySelectorAll('.companion-instance-switcher input, .companion-instance-switcher button, .companion-instance-switcher a')]
      .every(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth;
      })`,
  )) as boolean
  if (!fits) throw new Error('Companion instance links overflow the phone viewport')
}

async function captureLayouts(
  win: BrowserWindow,
  host: Pick<ProjectHost, 'writeFile'>,
): Promise<void> {
  for (const width of [375, 768, 1440]) {
    win.setContentSize(width, 812)
    await ready(win, `window.innerWidth === ${width}`)
    await assertPhoneLayout(win)
    await host.writeFile(
      localPath(`/tmp/hvir-companion-switcher-${width}.png`),
      (await win.webContents.capturePage()).toPNG(),
    )
  }
  win.setContentSize(375, 812)
  await ready(win, 'window.innerWidth === 375')
}

async function ready(win: BrowserWindow, condition: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await win.webContents.executeJavaScript(`Boolean(${condition})`)) as boolean)
      return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Companion phone did not reach expected state: ${condition}`)
}
