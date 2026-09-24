import type { BrowserWindow } from 'electron'
import { verifyArchitectureReviewAuthority } from './architecture-review-authority'
import { verifyArchitectureCommitStrip } from './architecture-review-strip'
import { verifyArchitectureReviewVisuals } from './architecture-review-visual'
import { ARCHITECTURE_LAYOUT_FILE, joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { ArchitectureReviewCoordinator } from '../architecture-review/coordinator'
import { ArchitectureAnalysisWorker } from '../architecture-review/worker'
import { ARCHITECTURE_PARSE_CACHE_BYTES } from '../architecture-review/parse-cache-budget'
import { architectureParseCacheDirectory } from '../architecture-review/runtime'
import type { SmokeCleanup } from './cleanup'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import {
  ARCHITECTURE_SMOKE_LAYOUT,
  createArchitectureReviewSmokeFixture,
  type ArchitectureReviewSmokeFixture,
} from './architecture-review-fixture'

export function createSmokeArchitectureReview(
  resources: RendererResourceScopes,
  cleanup: SmokeCleanup,
) {
  // The smoke harness gives every run its own user data root and removes it afterwards.
  const directory = architectureParseCacheDirectory()
  const worker = cleanup.acquire(
    'architecture analysis worker',
    () =>
      new ArchitectureAnalysisWorker({
        cache: { directory, maxBytes: ARCHITECTURE_PARSE_CACHE_BYTES },
      }),
    (owned) => owned.dispose(),
  )
  return cleanup.acquire(
    'architecture review',
    () => new ArchitectureReviewCoordinator({ resources, analyze: worker.analyze }),
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
      const baseline = [...surface().querySelectorAll('.architecture-review-controls label')].find(node => node.textContent?.startsWith('Baseline'))?.querySelector('input');
      if (!baseline || baseline.placeholder !== 'branch point') throw new Error('Baseline ref field missing its branch point default');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(baseline, 'HEAD');
      baseline.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(() => baseline.value === 'HEAD', 'typed Baseline ref');
      button('Scan snapshot').click();
      const body = await wait(() => document.querySelector('.architecture-review-body'), 'map');
      const stages = [...document.querySelectorAll('table[aria-label="Scan timings"] tbody th')].map(node => node.textContent);
      for (const stage of ['listing', 'live-read', 'worker-transfer', 'parse', 'worker-return', 'renderer-payload'])
        if (!stages.includes(stage)) throw new Error('Snapshot details miss scan stage ' + stage + ': ' + stages.join(','));
      for (const mode of ['before', 'after', 'overlay']) {
        const control = button(mode);
        if (!control) throw new Error('Missing map mode ' + mode);
        control.click();
        await wait(() => control.getAttribute('aria-pressed') === 'true', mode + ' map');
      }
      const detail = (term) => [...document.querySelectorAll('.architecture-review-metadata dt')].find(node => node.textContent === term)?.nextElementSibling?.textContent ?? '';
      if (!detail('Subsystems').startsWith('.hvir/architecture.json') || detail('Scope') !== 'architecture-smoke') throw new Error('Snapshot details do not name the tracked layout: ' + detail('Subsystems') + ' / ' + detail('Scope'));
      const relationship = [...body.querySelectorAll('[aria-label="Subsystem relationships"] .architecture-relationship')].find(node => node.querySelector('summary')?.textContent?.startsWith('architecture-smoke/ui → architecture-smoke/new-data'));
      if (!relationship?.querySelector('[aria-label="Imports in ${fixture.selectedPath}"] button')) throw new Error('Subsystem relationship does not drill to module import evidence');
      const subsystem = [...body.querySelectorAll('.architecture-subsystem')].find(node => node.querySelector('strong')?.textContent === 'architecture-smoke/ui');
      if (!subsystem) throw new Error('Changed subsystem missing');
      subsystem.focus();
      if (document.activeElement !== subsystem) throw new Error('Subsystem cannot receive keyboard focus');
      subsystem.click();
      const module = await wait(() => [...body.querySelectorAll('.architecture-module-list .architecture-module')].find(node => node.querySelector('span')?.textContent === ${JSON.stringify(fixture.selectedPath)}), 'selected subsystem files');
      if (![...body.querySelectorAll('.architecture-module-list .architecture-module span')].some(node => node.textContent === 'architecture-smoke/ui/app.py')) throw new Error('Python module missing: the worker did not scan the live Python files');
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
  await verifyLayoutRefusal(win, host, root)
  await verifyArchitectureCommitStrip(win, fixture)
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
    `[smoke] Architecture review OK (Git entry → keyboard focus → themes/layout → stale/refresh → DiffView → commit strip → ${close})`,
  )
  console.log('HVIR_SMOKE_OK')
  return 0
}

/** An invalid tracked layout refuses the scan with the file and field named in the UI. */
async function verifyLayoutRefusal(
  win: BrowserWindow,
  host: ProjectHost,
  root: HostPath,
): Promise<void> {
  const layout = joinHostPath(root, ARCHITECTURE_LAYOUT_FILE)
  await host.writeFile(layout, '{"version":2}\n')
  const refusal = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for the layout refusal')), 30000);
      const scan = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Scan snapshot');
      if (!scan) return reject(new Error('Architecture scan control missing'));
      scan.click();
      const wait = () => {
        const error = document.querySelector('[role="alert"]');
        if (error?.textContent?.includes('architecture.json')) return resolve(error.textContent);
        setTimeout(wait, 50);
      };
      wait();
    })
  `)) as string
  await host.writeFile(layout, ARCHITECTURE_SMOKE_LAYOUT)
  if (
    !refusal.includes('Invalid .hvir/architecture.json') ||
    !refusal.includes('"version"')
  )
    throw new Error(`Invalid layout was not refused by name: ${refusal}`)
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out rescanning after restoring the layout')), 30000);
      const scan = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Scan snapshot');
      if (!scan) return reject(new Error('Architecture scan control missing'));
      scan.click();
      const wait = () => {
        const surface = document.querySelector('[aria-label="Architecture review"]:not([hidden])');
        if (!surface?.querySelector('[role="alert"]') && surface?.querySelector('.architecture-review-body')) return resolve(true);
        setTimeout(wait, 50);
      };
      wait();
    })
  `)
}
