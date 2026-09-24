import type { BrowserWindow } from 'electron'
import { ARCHITECTURE_LAYOUT_FILE, joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { ARCHITECTURE_SMOKE_LAYOUT } from './architecture-review-fixture'

const SCOPE = 'architecture-smoke'

/**
 * Saves a scope through the real IPC authority when the layout file does not exist yet, so
 * the path it authorizes is the file's own and not its existing parent directory, then
 * checks the recorded file and restores the fixture layout.
 */
export async function verifyArchitectureScopeSave(
  win: BrowserWindow,
  host: ProjectHost,
  root: HostPath,
): Promise<string> {
  const layout = joinHostPath(root, ARCHITECTURE_LAYOUT_FILE)
  await host.removeFile(layout)
  const result = (await win.webContents.executeJavaScript(`
    (async () => {
      const wait = async (read, what) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw new Error('Timed out waiting for ' + what);
      };
      const surface = () => document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      const controls = await wait(() => surface()?.querySelector('.architecture-review-scope-controls'), 'scope controls');
      controls.open = true;
      const field = controls.querySelector('textarea');
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setValue.call(field, ${JSON.stringify(SCOPE)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      const save = [...controls.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Save scope and scan');
      await wait(() => save && !save.disabled, 'an enabled save control');
      const previous = surface().querySelector('.architecture-review-body');
      save.click();
      await wait(() => {
        const alert = surface()?.querySelector('[role="alert"]');
        if (alert) throw new Error('Saving the scope failed: ' + alert.textContent);
        const body = surface()?.querySelector('.architecture-review-body');
        return body !== previous && body?.querySelector('.architecture-review-map');
      }, 'a scan with the saved scope');
      return controls.querySelector('summary')?.textContent ?? '';
    })()
  `)) as string
  const recorded: unknown = JSON.parse(await host.readTextFile(layout))
  await host.writeFile(layout, ARCHITECTURE_SMOKE_LAYOUT)
  if (JSON.stringify(recorded) !== JSON.stringify({ version: 1, scope: [SCOPE] }))
    throw new Error(`Scope was not recorded in the layout file: ${JSON.stringify(recorded)}`)
  if (!result.includes(SCOPE))
    throw new Error(`Scope summary does not show the saved scope: ${result}`)
  console.log('[smoke] architecture scope save OK (new layout file, rescanned)')
  return result
}
