import { clipboard, type BrowserWindow } from 'electron'

const SYNTHETIC_RUN_URL = 'https://eval.example/runs/smoke-91'
const SYNTHETIC_HEAD = '0123456789abcdef0123456789abcdef01234567'
const HOSTILE_PREFIX = '<img src=x onerror=alert(1)>'

export async function verifyQolRailView(win: BrowserWindow): Promise<string> {
  await verifyBeadEvaluation(win)
  const copyStatus = await verifyPullFeedback(win)
  return `synthetic Bead evaluation + PR feedback preview${copyStatus}`
}

async function verifyBeadEvaluation(win: BrowserWindow): Promise<void> {
  await clickRailTab(win, 'Gas City', '.beads-panel')
  await waitFor(win, `Boolean(document.querySelector('[data-bead-id="smoke-eval-1"]'))`)
  await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('[data-bead-id="smoke-eval-1"] .beads-row');
      if (!(row instanceof HTMLButtonElement)) throw new Error('Synthetic evaluation bead row missing');
      row.click();
    })()
  `)
  await waitFor(
    win,
    `Boolean(document.querySelector('[aria-label="Evaluation result"] a'))`,
  )
  const facts = (await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.beads-panel');
    const link = panel?.querySelector('[aria-label="Evaluation result"] a');
    return {
      href: link?.getAttribute('href'),
      text: panel?.textContent ?? '',
      untrustedNodes: panel?.querySelectorAll('img,script,iframe').length ?? 0,
    };
  })()`)) as {
    readonly href?: string
    readonly text: string
    readonly untrustedNodes: number
  }
  if (facts.href !== SYNTHETIC_RUN_URL)
    throw new Error('Synthetic evaluation URL changed in the expanded card')
  if (
    !facts.text.includes(SYNTHETIC_HEAD) ||
    !facts.text.includes('Producer-supplied. Current result not verified.')
  ) {
    throw new Error('Synthetic evaluation facts or provenance were omitted')
  }
  if (facts.untrustedNodes !== 0)
    throw new Error('Synthetic evaluation metadata created executable markup')
}

async function verifyPullFeedback(win: BrowserWindow): Promise<string> {
  await clickRailTab(win, 'PRs', '.pulls-panel')
  await waitFor(
    win,
    `Boolean(document.querySelector('[data-pull-number="91"] .pulls-detail-button'))`,
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-pull-number="91"] .pulls-detail-button')?.click()`,
  )
  await waitFor(
    win,
    `Boolean(document.querySelector('.pulls-feedback-detail input[type="checkbox"]'))`,
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('.pulls-feedback-detail input[type="checkbox"]')?.click()`,
  )
  await waitFor(win, `Boolean(document.querySelector('.pulls-detail-preview'))`)
  const sizes = win.getContentSize()
  try {
    for (const width of [375, 768, 1440]) {
      win.setContentSize(width, sizes[1] ?? 800)
      await waitFor(
        win,
        `innerWidth === ${width} && (() => {
        const panel = document.querySelector('.pulls-feedback-detail');
        return panel instanceof HTMLElement && panel.scrollWidth <= panel.clientWidth + 1;
      })()`,
      )
    }
  } finally {
    win.setContentSize(sizes[0] ?? 1440, sizes[1] ?? 800)
  }
  const preview = (await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.pulls-feedback-detail');
    const pre = panel?.querySelector('.pulls-detail-preview');
    return {
      text: pre?.textContent ?? '',
      htmlNodes: panel?.querySelectorAll('img,script,iframe').length ?? 0,
      button: [...(panel?.querySelectorAll('button') ?? [])].find((candidate) => candidate.textContent?.trim() === 'Copy preview'),
    };
  })()`)) as {
    readonly text: string
    readonly htmlNodes: number
    readonly button?: Element
  }
  if (!preview.text.includes(HOSTILE_PREFIX) || !preview.text.includes(SYNTHETIC_HEAD)) {
    throw new Error(
      'PR feedback preview omitted exact untrusted content or head provenance',
    )
  }
  if (preview.htmlNodes !== 0)
    throw new Error('PR feedback created executable markup from untrusted content')
  const copied = await copyPreview(win, preview.text)
  return copied
}

async function copyPreview(win: BrowserWindow, expected: string): Promise<string> {
  const before = clipboard.readText()
  const wasVisible = win.isVisible()
  const clipboardAvailable = (await win.webContents.executeJavaScript(
    'Boolean(navigator.clipboard?.writeText)',
  )) as boolean
  if (!clipboardAvailable) throw new Error('Clipboard API unavailable')
  try {
    if (!wasVisible) win.show()
    win.focus()
    win.webContents.focus()
    const buttonReady = (await win.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('.pulls-feedback-detail button')]
        .find((candidate) => candidate.textContent?.trim() === 'Copy preview')
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false
      button.focus()
      return document.activeElement === button
    })()`)) as boolean
    if (!buttonReady) throw new Error('copy button unavailable')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await waitFor(
      win,
      `Boolean(document.querySelector('.pulls-feedback-detail [role="alert"]')?.textContent?.trim())`,
    )
    const status = (await win.webContents.executeJavaScript(
      `document.querySelector('.pulls-feedback-detail [role="alert"]')?.textContent?.trim() ?? ''`,
    )) as string
    if (status === 'Clipboard copy was refused.')
      throw new Error('Clipboard permission denied')
    if (status !== 'Exact preview copied.') throw new Error('unexpected clipboard status')
    const copied = clipboard.readText()
    if (copied === expected) {
      return ' + clipboard exact bytes'
    }
    throw new Error('clipboard bytes mismatched')
  } finally {
    clipboard.writeText(before)
    if (!wasVisible) win.hide()
  }
}

async function clickRailTab(
  win: BrowserWindow,
  label: string,
  selector: string,
): Promise<void> {
  await waitFor(
    win,
    `Boolean([...document.querySelectorAll('.rail-nav button')].find((button) => button.textContent?.trim() === ${JSON.stringify(label)}))`,
  )
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.rail-nav button')]
      .find((button) => button.textContent?.trim() === ${JSON.stringify(label)})?.click()
  `)
  await waitFor(win, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)
}

async function waitFor(win: BrowserWindow, condition: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${condition})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`QOL rail smoke timed out: ${condition}`)
}
