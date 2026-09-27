import type { BrowserWindow } from 'electron'
import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { createArchitectureReviewSmokeFixture } from './architecture-review-fixture'
import {
  beginUxWalkthrough,
  captureUxWalkthroughStep,
  completeUxWalkthrough,
  uxWalkthroughConfiguration,
} from './ux-walkthrough-artifacts'

const LIVE_REVIEW_SETTLE_MS = 2300

export async function runArchitectureUxWalkthrough(
  win: BrowserWindow,
  root: HostPath,
  host: ProjectHost,
): Promise<number> {
  const configuration = uxWalkthroughConfiguration(process.env, host)
  const fixture = await createArchitectureReviewSmokeFixture(host, root)
  const originalSize = win.getContentSize()
  let manifest = await beginUxWalkthrough(
    host,
    root,
    configuration.directory,
    configuration.journey,
  )
  const capture = async (
    id: string,
    title: string,
    prepare?: () => Promise<void>,
  ): Promise<void> => {
    await assertArchitectureLayout(win)
    await prepare?.()
    manifest = await captureUxWalkthroughStep(
      host,
      win,
      configuration.directory,
      manifest,
      { id, title },
    )
  }
  try {
    win.setContentSize(1440, 1000)
    await new Promise((resolve) => setTimeout(resolve, LIVE_REVIEW_SETTLE_MS))
    await openArchitecture(win)
    await scanLiveReview(win)
    await capture('open-architecture', 'Open Architecture and scan the working tree')

    const collapsedCanvasHeight = await expandArchitectureMap(win)
    await capture('expand-map', 'Expand the architecture map')
    await collapseArchitectureMap(win, collapsedCanvasHeight)

    await expandArchitectureSystem(win)
    await capture('expand-system', 'Expand a system on the architecture map')

    await compareCommit(win, fixture.history.label)
    await capture('compare-two-commits', 'Compare two commits from the commit strip')

    await scanLiveReview(win)
    await assertLiveTimeline(win, 1)
    await capture('start-live-review', 'Return to a live working-tree review')

    await observeStableLiveReview(win, 1)
    await capture('live-review-idle', 'Observe that an idle live review stays stable')

    await host.writeFile(
      joinHostPath(root, fixture.selectedPath),
      `${fixture.afterSource}export const walkthroughEdit = true\n`,
    )
    await assertLiveTimeline(win, 2)
    await observeStableLiveReview(win, 2)
    await capture('follow-working-tree-edit', 'Follow one working-tree edit live')

    await pauseAndScroll(win)
    await capture(
      'pause-live-review',
      'Pause the live review without losing map position',
    )

    await scanPausedReview(win)
    await capture('scan-live-snapshot', 'Scan a snapshot while the live review is paused')

    await compareCommit(win, fixture.history.label)
    await prepareExplanation(win)
    await capture('explain-change', 'Prepare an agent explanation handoff', () =>
      focusExplanation(win),
    )

    await collapseExplanation(win)
    await capture(
      'collapse-explanation',
      'Collapse the Explanation panel to its header',
      () => focusExplanation(win),
    )
    await expandExplanation(win)

    manifest = await completeUxWalkthrough(host, configuration.directory, manifest)
    console.log(
      `[smoke] UX walkthrough captured ${manifest.steps.length} steps at ${configuration.directory.path}`,
    )
    console.log('HVIR_SMOKE_OK')
    return 0
  } finally {
    win.setContentSize(originalSize[0]!, originalSize[1]!)
  }
}

async function assertArchitectureLayout(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const check = () => {
        const body = document.querySelector('.architecture-review-body');
        const alert = body?.querySelector('[role="alert"]');
        if (alert) return reject(new Error(alert.textContent || 'Architecture layout failed'));
        const nodes = body?.querySelectorAll('.architecture-canvas-node') ?? [];
        if (nodes.length && [...nodes].every(node => node instanceof HTMLElement && node.style.transform)) {
          body.querySelector('.architecture-map-canvas')?.scrollIntoView({ block: 'center' });
          return requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        }
        if (Date.now() >= deadline) return reject(new Error('Timed out waiting for architecture nodes'));
        setTimeout(check, 40);
      };
      check();
    })
  `)
}

async function openArchitecture(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
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
      button('Git')?.click();
      (await wait(() => button('Architecture'), 'Architecture navigation entry')).click();
      await wait(() => document.querySelector('[aria-label="Architecture review"]:not([hidden])'), 'Architecture surface');
    })()
  `)
}

async function scanLiveReview(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    (async () => {
      const surface = () => document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      const wait = async (read, label) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw new Error('Timed out waiting for ' + label);
      };
      const review = await wait(surface, 'Architecture surface');
      const labels = [...review.querySelectorAll('.architecture-review-controls label')];
      const baseline = labels.find(node => node.textContent?.startsWith('Baseline'))?.querySelector('input');
      const current = labels.find(node => node.textContent?.startsWith('Current'))?.querySelector('input');
      if (!(baseline instanceof HTMLInputElement) || !(current instanceof HTMLInputElement)) throw new Error('Snapshot end controls are missing');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(baseline, 'HEAD');
      baseline.dispatchEvent(new Event('input', { bubbles: true }));
      set.call(current, '');
      current.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(() => baseline.value === 'HEAD' && current.value === '', 'live snapshot ends');
      const scan = [...review.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Scan snapshot');
      if (!(scan instanceof HTMLButtonElement)) throw new Error('Scan snapshot control is missing');
      scan.click();
      let started = false;
      await wait(() => {
        if (scan.disabled || scan.textContent?.trim() === 'Scanning…') started = true;
        return started && !scan.disabled && scan.textContent?.trim() === 'Scan snapshot' && review.querySelector('.architecture-review-body') && review.querySelector('.architecture-review-timeline');
      }, 'live architecture map');
      const canvas = await wait(() => review.querySelector('.architecture-map-canvas'), 'architecture canvas');
      const reviewBounds = review.getBoundingClientRect();
      const canvasBounds = canvas.getBoundingClientRect();
      const visibleCanvasHeight = Math.min(canvasBounds.bottom, reviewBounds.bottom) - Math.max(canvasBounds.top, reviewBounds.top);
      if (review.scrollTop !== 0 || visibleCanvasHeight < 240) {
        throw new Error('Architecture map has only ' + Math.max(0, visibleCanvasHeight) + ' visible pixels when the review opens');
      }
    })()
  `)
}

async function expandArchitectureSystem(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const wait = () => {
        const system = document.querySelector('.architecture-canvas-system');
        if (system instanceof HTMLElement) {
          system.click();
          const expanded = () => {
            if (document.querySelector('.architecture-canvas-subsystem')) {
              document.querySelector('.react-flow__controls-fitview')?.click();
              return requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
            }
            if (Date.now() >= deadline) return reject(new Error('Timed out waiting for expanded architecture system'));
            setTimeout(expanded, 40);
          };
          return expanded();
        }
        if (Date.now() >= deadline) return reject(new Error('Timed out waiting for architecture system'));
        setTimeout(wait, 40);
      };
      wait();
    })
  `)
}

async function expandArchitectureMap(win: BrowserWindow): Promise<number> {
  return (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const surface = document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      const canvas = surface?.querySelector('.architecture-map-canvas');
      const button = surface?.querySelector('[aria-label="Expand architecture map"]');
      if (!(surface instanceof HTMLElement) || !(canvas instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
        return reject(new Error('Architecture map expansion controls disappeared'));
      }
      const collapsedHeight = canvas.getBoundingClientRect().height;
      button.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const surfaceBounds = surface.getBoundingClientRect();
        const canvasBounds = canvas.getBoundingClientRect();
        const nodeCount = canvas.querySelectorAll('.architecture-canvas-node').length;
        if (button.getAttribute('aria-expanded') !== 'true') return reject(new Error('Architecture map did not expand'));
        if (canvasBounds.height < surfaceBounds.height * 0.6 || nodeCount === 0) {
          return reject(new Error('Expanded architecture canvas geometry: ' + JSON.stringify({ canvasHeight: canvasBounds.height, surfaceHeight: surfaceBounds.height, ratio: canvasBounds.height / surfaceBounds.height, nodeCount })));
        }
        resolve(collapsedHeight);
      }));
    })
  `)) as number
}

async function collapseArchitectureMap(
  win: BrowserWindow,
  collapsedCanvasHeight: number,
): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const surface = document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      const canvas = surface?.querySelector('.architecture-map-canvas');
      const button = surface?.querySelector('[aria-label="Collapse architecture map"]');
      if (!(canvas instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
        return reject(new Error('Architecture map collapse controls disappeared'));
      }
      button.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const restoredHeight = canvas.getBoundingClientRect().height;
        if (button.getAttribute('aria-expanded') !== 'false' || Math.abs(restoredHeight - ${collapsedCanvasHeight}) > 2) {
          return reject(new Error('Architecture map did not restore collapsed geometry: ' + JSON.stringify({ expectedHeight: ${collapsedCanvasHeight}, restoredHeight })));
        }
        resolve(true);
      }));
    })
  `)
}

async function compareCommit(win: BrowserWindow, revision: string): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const find = () => document.querySelector('[aria-label="Commit strip"] button[title=${JSON.stringify(revision)}]');
      const wait = () => {
        const commit = find();
        if (commit instanceof HTMLButtonElement) {
          commit.click();
          let started = false;
          const scanned = () => {
            const surface = document.querySelector('[aria-label="Architecture review"]:not([hidden])');
            const scan = [...(surface?.querySelectorAll('button') || [])].find(node => node.textContent?.trim() === 'Scanning…' || node.textContent?.trim() === 'Scan snapshot');
            if (scan?.textContent?.trim() === 'Scanning…') started = true;
            if (started && scan?.textContent?.trim() === 'Scan snapshot' && commit.getAttribute('aria-pressed') === 'true' && surface?.querySelector('.architecture-review-body')) return resolve(true);
            if (Date.now() >= deadline) return reject(new Error('Timed out waiting for commit comparison'));
            setTimeout(scanned, 40);
          };
          return scanned();
        }
        if (Date.now() >= deadline) return reject(new Error('Timed out waiting for fixture commit'));
        setTimeout(wait, 40);
      };
      wait();
    })
  `)
}

async function assertLiveTimeline(win: BrowserWindow, expected: number): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const expected = ${expected};
      const wait = () => {
        const label = document.querySelector('.architecture-review-timeline label')?.textContent || '';
        const match = label.match(/Snapshot (\\d+) of (\\d+)/);
        if (match && Number(match[2]) === expected) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('Timed out waiting for live snapshot count ' + expected + '; saw ' + label.trim()));
        setTimeout(wait, 40);
      };
      wait();
    })
  `)
}

async function observeStableLiveReview(
  win: BrowserWindow,
  expected: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, LIVE_REVIEW_SETTLE_MS))
  const count = (await win.webContents.executeJavaScript(`
    (() => {
      const label = document.querySelector('.architecture-review-timeline label')?.textContent || '';
      return Number(label.match(/Snapshot (\\d+) of (\\d+)/)?.[2] || 0);
    })()
  `)) as number
  if (count !== expected)
    throw new Error(
      `Live review created unexpected snapshots: expected ${expected}, saw ${count}`,
    )
}

async function pauseAndScroll(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Pause live review');
      if (!(button instanceof HTMLButtonElement)) return reject(new Error('Pause live review control is missing'));
      for (const selector of ['.architecture-review', '.architecture-review-body', '.architecture-map-scroll']) {
        const node = document.querySelector(selector);
        if (node instanceof HTMLElement) {
          node.scrollTop = Math.min(160, Math.max(0, node.scrollHeight - node.clientHeight));
          node.scrollLeft = Math.min(120, Math.max(0, node.scrollWidth - node.clientWidth));
        }
      }
      button.click();
      const deadline = Date.now() + 30000;
      const wait = () => {
        if ([...document.querySelectorAll('button')].some(node => node.textContent?.trim() === 'Resume live review')) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('Timed out pausing live review'));
        setTimeout(wait, 40);
      };
      wait();
    })
  `)
}

async function scanPausedReview(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const surface = document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      const scan = [...(surface?.querySelectorAll('button') || [])].find(node => node.textContent?.trim() === 'Scan snapshot');
      if (!(surface instanceof HTMLElement) || !(scan instanceof HTMLButtonElement)) return reject(new Error('Paused scan controls are missing'));
      scan.click();
      const deadline = Date.now() + 30000;
      let started = false;
      const wait = () => {
        if (scan.disabled || scan.textContent?.trim() === 'Scanning…') started = true;
        const resume = [...surface.querySelectorAll('button')].some(node => node.textContent?.trim() === 'Resume live review');
        if (started && !scan.disabled && scan.textContent?.trim() === 'Scan snapshot' && surface.querySelector('.architecture-review-map') && resume && !surface.hidden) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error('Timed out scanning paused live review'));
        setTimeout(wait, 40);
      };
      wait();
    })
  `)
}

async function prepareExplanation(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const surface = document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      const button = [...(surface?.querySelectorAll('button') || [])].find(node => node.textContent?.trim() === 'Explain this change');
      if (!(button instanceof HTMLButtonElement)) return reject(new Error('Explain this change control is missing'));
      button.click();
      const deadline = Date.now() + 30000;
      const wait = () => {
        const explanation = surface.querySelector('.architecture-explanation');
        const busy = [...(explanation?.querySelectorAll('button') || [])].some(node => node.textContent?.trim() === 'Preparing…');
        const launch = explanation?.querySelector('.architecture-explanation-launch');
        const failure = explanation?.querySelector('[role="alert"]');
        if (!busy && launch) return resolve(true);
        if (!busy && failure) return reject(new Error(failure.textContent?.trim() || 'Explanation handoff failed'));
        if (Date.now() >= deadline) return reject(new Error('Timed out preparing the explanation handoff'));
        setTimeout(wait, 40);
      };
      wait();
    })
  `)
}

async function focusExplanation(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const surface = document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      const explanation = surface?.querySelector('.architecture-explanation');
      if (!(surface instanceof HTMLElement) || !(explanation instanceof HTMLElement)) {
        return reject(new Error('Explanation panel is missing'));
      }
      explanation.scrollIntoView({ block: 'center' });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const surfaceBounds = surface.getBoundingClientRect();
        const explanationBounds = explanation.getBoundingClientRect();
        const visibleTop = Math.max(0, surfaceBounds.top);
        const visibleBottom = Math.min(innerHeight, surfaceBounds.bottom);
        if (explanationBounds.top < visibleTop - 1 || explanationBounds.bottom > visibleBottom + 1) {
          return reject(new Error('Explanation panel did not scroll fully into view'));
        }
        resolve(true);
      }));
    })
  `)
}

async function collapseExplanation(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const explanation = document.querySelector('[aria-label="Architecture review"]:not([hidden]) .architecture-explanation');
      const button = explanation?.querySelector('[aria-label="Collapse explanation panel"]');
      if (!(explanation instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
        return reject(new Error('Explanation panel collapse control is missing'));
      }
      button.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const expand = explanation.querySelector('[aria-label="Expand explanation panel"]');
        const headerOnly = explanation.children.length === 1 && explanation.firstElementChild?.tagName === 'HEADER';
        if (!(expand instanceof HTMLButtonElement) || expand.getAttribute('aria-expanded') !== 'false' || !headerOnly) {
          return reject(new Error('Explanation panel did not collapse to its header'));
        }
        resolve(true);
      }));
    })
  `)
}

async function expandExplanation(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const explanation = document.querySelector('[aria-label="Architecture review"]:not([hidden]) .architecture-explanation');
      const button = explanation?.querySelector('[aria-label="Expand explanation panel"]');
      if (!(explanation instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
        return reject(new Error('Explanation panel expand control is missing'));
      }
      button.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const collapse = explanation.querySelector('[aria-label="Collapse explanation panel"]');
        const explain = [...explanation.querySelectorAll('button')].some(node => node.textContent?.trim() === 'Explain this change');
        if (!(collapse instanceof HTMLButtonElement) || collapse.getAttribute('aria-expanded') !== 'true' || !explain) {
          return reject(new Error('Explanation panel did not expand'));
        }
        resolve(true);
      }));
    })
  `)
}
