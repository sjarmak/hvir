import type { BrowserWindow } from 'electron'

const PICKER_TIMEOUT_MS = 15_000
const PICKER_CHECK_INTERVAL_MS = 25

/** Keep each renderer evaluation finite while the real picker completes its IPC. */
export async function verifySessionsProjectPickerReturn(
  win: BrowserWindow,
): Promise<string> {
  const deadline = Date.now() + PICKER_TIMEOUT_MS
  await win.webContents.executeJavaScript(
    `document.querySelector('.sessions-destination')?.click()`,
  )
  await waitForPickerState(
    win,
    deadline,
    `Boolean(document.querySelector('.sessions-overview'))`,
    'overview',
  )
  for (const label of ['Register project', 'Choose folder', 'Use this folder']) {
    await waitForPickerState(
      win,
      deadline,
      `(() => {
        const root = ${label === 'Register project' ? 'document' : "document.querySelector('.session-dialog')"};
        const button = [...(root?.querySelectorAll('button') ?? [])].find(candidate =>
          candidate.getAttribute('aria-label') === ${JSON.stringify(label)} ||
          candidate.textContent?.trim() === ${JSON.stringify(label)}
        );
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
        button.click();
        return true;
      })()`,
      label,
    )
  }
  await waitForPickerState(
    win,
    deadline,
    `(() => {
      const workbench = document.querySelector('.workbench');
      return !document.querySelector('.session-dialog') &&
        !document.querySelector('.sessions-overview') &&
        workbench instanceof HTMLElement && !workbench.hidden;
    })()`,
    'workspace return',
  )
  return 'successful project open returns to workspace'
}

async function waitForPickerState(
  win: BrowserWindow,
  deadline: number,
  condition: string,
  stage: string,
): Promise<void> {
  let state: { readonly ready: boolean } | undefined
  while (Date.now() <= deadline) {
    state = (await win.webContents.executeJavaScript(`({
      ready: ${condition},
      dialog: Boolean(document.querySelector('.session-dialog')),
      error: Boolean(document.querySelector('.session-dialog .dialog-error')),
      overview: Boolean(document.querySelector('.sessions-overview')),
      workbenchHidden: document.querySelector('.workbench')?.hidden ?? null
    })`)) as { readonly ready: boolean }
    if (state.ready) return
    await new Promise<void>((resolve) => setTimeout(resolve, PICKER_CHECK_INTERVAL_MS))
  }
  throw new Error(
    `Sessions project-picker return timed out at ${stage}: ${JSON.stringify(state)}`,
  )
}
