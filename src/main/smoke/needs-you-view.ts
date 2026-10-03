import { app, type BrowserWindow } from 'electron'
import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

export async function verifyNeedsYouView(
  win: BrowserWindow,
  host: ProjectHost,
  captureDirectory?: HostPath,
): Promise<string> {
  if (!win.isVisible()) win.show()
  app.focus({ steal: true })
  win.focus()
  win.webContents.focus()
  await waitFor(
    win,
    `Boolean([...document.querySelectorAll('.sessions-destination')].find(button => button.textContent.trim() === 'Needs you'))`,
  )
  const focused = (await win.webContents.executeJavaScript(`
    (() => {
      const button = [...document.querySelectorAll('.sessions-destination')]
        .find(candidate => candidate.textContent.trim() === 'Needs you')
      if (!(button instanceof HTMLElement)) return false
      button.focus()
      return document.activeElement === button
    })()
  `)) as boolean
  if (!focused) throw new Error('Needs you smoke could not focus destination keyboard target')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await waitFor(win, `document.activeElement?.id === 'needs-you-heading'`)
  await waitFor(win, `Boolean(document.querySelector('.needs-you-reads'))`)
  const liveSnapshot = (await win.webContents.executeJavaScript(`
    window.hvir.invoke('needs-you:snapshot', { demandGeneration: 1 })
  `)) as { readonly demandGeneration: number; readonly revision: number }
  if (liveSnapshot.demandGeneration !== 1 || liveSnapshot.revision < 1) {
    throw new Error('Needs you smoke did not establish its active observation generation')
  }
  const originalSize = win.getContentSize()
  try {
    for (const width of [1440, 768, 375]) {
      win.setContentSize(width, 800)
      await waitFor(
        win,
        `(() => {
        const view = document.querySelector('.needs-you-view');
        return innerWidth === ${width} && view && view.clientWidth > 0 &&
          view.scrollWidth <= view.clientWidth + 1;
      })()`,
      )
      if (captureDirectory) {
        const screenshot = await win.webContents.capturePage()
        await host.writeFile(
          joinHostPath(captureDirectory, `needs-you-${width}.png`),
          screenshot.toPNG(),
        )
      }
    }
  } finally {
    win.setContentSize(originalSize[0]!, originalSize[1]!)
  }
  await win.webContents.executeJavaScript(`
    document.querySelector('.needs-you-header button')?.click()
  `)
  await waitFor(
    win,
    `document.querySelector('.needs-you-view [role=status]')?.textContent?.includes('Reading') === true`,
  )
  await waitFor(
    win,
    `Boolean(document.querySelector('.needs-you-reads')) && !document.querySelector('.needs-you-view [role=status]')?.textContent?.includes('Reading')`,
  )
  const refreshedSnapshot = (await win.webContents.executeJavaScript(`
    window.hvir.invoke('needs-you:snapshot', { demandGeneration: 1 })
  `)) as { readonly demandGeneration: number; readonly revision: number }
  if (
    refreshedSnapshot.demandGeneration !== liveSnapshot.demandGeneration ||
    refreshedSnapshot.revision <= liveSnapshot.revision
  ) {
    throw new Error('Needs you smoke refresh did not produce a newer active snapshot')
  }
  await win.webContents.executeJavaScript(`
    document.querySelector('.project-tab .project-tab-main')?.click()
  `)
  await waitFor(win, `!document.querySelector('.needs-you-view')`)
  const released = (await win.webContents.executeJavaScript(`
    window.hvir.invoke('needs-you:snapshot', { demandGeneration: 1 }).then(
      () => false, () => true
    )
  `)) as boolean
  if (!released) throw new Error('Needs you retained demand after workspace return')
  return 'Needs you keyboard entry + responsive reads + refresh + release'
}

async function waitFor(win: BrowserWindow, condition: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${condition})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  const state = (await win.webContents.executeJavaScript(`({
    active: document.activeElement?.outerHTML.slice(0, 300),
    focused: document.hasFocus(),
    visible: Boolean(document.querySelector('.needs-you-view')),
    status: document.querySelector('.needs-you-view [role=status]')?.textContent
  })`)) as {
    readonly active?: string
    readonly focused: boolean
    readonly visible: boolean
    readonly status?: string
  }
  throw new Error(`Needs you smoke timed out: ${condition}: ${JSON.stringify(state)}`)
}
