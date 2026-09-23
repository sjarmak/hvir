import type { BrowserWindow } from 'electron'
import { verifyArchitectureReviewAuthority } from './architecture-review-authority'
import { verifyArchitectureReviewVisuals } from './architecture-review-visual'
import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { ArchitectureReviewCoordinator } from '../architecture-review/coordinator'
import { analyzeInWorker } from '../architecture-review/worker'
import type { SmokeCleanup } from './cleanup'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import {
  createArchitectureReviewSmokeFixture,
  type ArchitectureReviewSmokeFixture,
} from './architecture-review-fixture'

export function createSmokeArchitectureReview(
  resources: RendererResourceScopes,
  cleanup: SmokeCleanup,
) {
  return cleanup.acquire(
    'architecture review',
    () => new ArchitectureReviewCoordinator({ resources, analyze: analyzeInWorker }),
    (review) => review.dispose(),
  )
}

/** Exercises the native architecture surface through Chromium and production IPC. */
export async function verifyArchitectureReviewWorkflow(
  win: BrowserWindow,
  fixture: ArchitectureReviewSmokeFixture,
): Promise<string> {
  const result = (await win.webContents.executeJavaScript(`
    (async () => {
      const wait = async (read, label) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw new Error('Timed out waiting for ' + label);
      };
      const button = (label) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
      const surface = () => document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      button('Git')?.click();
      (await wait(() => button('Architecture'), 'Git entry')).click();
      await wait(surface, 'architecture surface');
      button('Scan snapshot').click();
      document.querySelector('.architecture-review-tab .tab-close').click();
      await wait(() => !surface(), 'cancelled scan');
      button('Architecture').click();
      await wait(surface, 'reopened surface');
      button('Scan snapshot').click();
      const body = await wait(() => document.querySelector('.architecture-review-body'), 'map');
      for (const mode of ['before', 'after', 'overlay']) {
        const control = button(mode);
        if (!control) throw new Error('Missing map mode ' + mode);
        control.click();
        await wait(() => control.getAttribute('aria-pressed') === 'true', mode + ' map');
      }
      const subsystem = [...body.querySelectorAll('.architecture-subsystem')].find(node => node.querySelector('strong')?.textContent === 'architecture-smoke/ui');
      if (!subsystem) throw new Error('Changed subsystem missing');
      subsystem.focus();
      if (document.activeElement !== subsystem) throw new Error('Subsystem cannot receive keyboard focus');
      subsystem.click();
      const module = await wait(() => [...body.querySelectorAll('.architecture-module-list .architecture-module')].find(node => node.querySelector('span')?.textContent === ${JSON.stringify(fixture.selectedPath)}), 'selected subsystem files');
      module.click();
      await wait(() => document.querySelector('.architecture-evidence .diff-host .cm-content'), 'native DiffView');
      const contents = [...document.querySelectorAll('.architecture-evidence .cm-content')].map(node => node.textContent);
      if (!contents.some(text => text.includes("../old-data/item")) || !contents.some(text => text.includes("../new-data/item"))) throw new Error('DiffView does not show the exact captured source pair');
      return document.querySelector('.architecture-evidence h3')?.textContent?.trim() ?? '';
    })()
  `)) as string
  console.log(`[smoke] architecture review workflow OK (${result})`)
  return result
}

export async function runArchitectureReviewSmoke(
  win: BrowserWindow,
  root: HostPath,
  host: ProjectHost,
): Promise<number> {
  const fixture = await createArchitectureReviewSmokeFixture(host, root)
  await verifyArchitectureReviewAuthority(win, fixture)
  const path = await verifyArchitectureReviewWorkflow(win, fixture)
  if (!path) throw new Error('Architecture evidence path missing')
  await verifyArchitectureReviewVisuals(win, host, root)
  const source = joinHostPath(root, path)
  const original = await host.readFile(source)
  await host.writeFile(
    source,
    Buffer.concat([original, Buffer.from('\n// smoke stale marker\n')]),
  )
  const stale = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for stale architecture evidence')), 30000);
      const module = [...document.querySelectorAll('.architecture-module')].find((node) => node.textContent?.includes(${JSON.stringify(path)}));
      if (!module) return reject(new Error('Architecture evidence module disappeared'));
      module.click();
      const wait = () => {
        const status = [...document.querySelectorAll('[role="status"]')].find((node) => node.textContent?.includes('stale'));
        if (status) return resolve(status.textContent);
        setTimeout(wait, 50);
      };
      wait();
    })
  `)) as string
  if (!stale.includes('stale'))
    throw new Error('Architecture evidence did not report stale capture')
  await host.writeFile(source, Uint8Array.from([0xff, 0xfe, 0xfd]))
  const unsupported = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for unsupported architecture scan')), 30000);
      const scan = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Scan snapshot');
      if (!scan) return reject(new Error('Architecture unsupported-state scan control missing'));
      scan.click();
      const wait = () => {
        const error = document.querySelector('[role="alert"]');
        if (error?.textContent?.includes('Unsupported')) return resolve(error.textContent);
        setTimeout(wait, 50);
      };
      wait();
    })
  `)) as string
  if (!unsupported.includes('Unsupported'))
    throw new Error('Invalid source did not produce an explicit unsupported-state error')
  await host.writeFile(
    source,
    Buffer.concat([original, Buffer.from('\nexport const refreshed = true\n')]),
  )
  const refreshed = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for architecture refresh')), 30000);
      const scan = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Scan snapshot');
      if (!scan) return reject(new Error('Architecture refresh control missing'));
      scan.click();
      const wait = () => {
        if (document.querySelector('.architecture-review-body .architecture-review-map')) return resolve('refreshed');
        const error = document.querySelector('[role="alert"]');
        if (error) return reject(new Error(error.textContent || 'Architecture refresh failed'));
        setTimeout(wait, 50);
      };
      requestAnimationFrame(wait);
    })
  `)) as string
  if (refreshed !== 'refreshed') throw new Error('Architecture review did not refresh')
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out checking refreshed source evidence')), 30000);
      const subsystem = [...document.querySelectorAll('.architecture-subsystem')].find(node => node.querySelector('strong')?.textContent === 'architecture-smoke/ui');
      if (!subsystem) return reject(new Error('Refreshed subsystem is missing'));
      subsystem.click();
      const open = () => {
        const module = [...document.querySelectorAll('.architecture-module-list .architecture-module')].find(node => node.querySelector('span')?.textContent === ${JSON.stringify(path)});
        if (!module) return setTimeout(open, 40);
        module.click();
        const verify = () => {
          const contents = [...document.querySelectorAll('.architecture-evidence .cm-content')].map(node => node.textContent);
          if (contents.some(text => text.includes('refreshed = true')) && contents.some(text => text.includes('../old-data/item'))) return resolve(true);
          setTimeout(verify, 40);
        };
        verify();
      };
      requestAnimationFrame(open);
    })
  `)

  const close = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out closing architecture review')), 30000);
      const control = document.querySelector('.architecture-review-tab .tab-close');
      if (!control) return reject(new Error('Architecture tab close control missing'));
      control.click();
      const wait = () => document.querySelector('[aria-label="Architecture review"]:not([hidden])') ? setTimeout(wait, 40) : resolve('closed');
      wait();
    })
  `)) as string
  if (close !== 'closed') throw new Error('Architecture review did not close')
  console.log(
    `[smoke] Architecture review OK (Git entry → keyboard focus → themes/layout → stale/refresh → DiffView → ${close})`,
  )
  console.log('HVIR_SMOKE_OK')
  return 0
}
