import { isAbsolute } from 'node:path'
import type { BrowserWindow } from 'electron'
import { hostPath, joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

export interface UxWalkthroughStep {
  readonly id: string
  readonly title: string
  readonly screenshot: string
  readonly note: string
  readonly capturedAt: string
}

export interface UxWalkthroughManifest {
  readonly schemaVersion: 1
  readonly journey: string
  readonly startedAt: string
  readonly completedAt?: string
  readonly steps: readonly UxWalkthroughStep[]
}

export function uxWalkthroughConfiguration(
  environment: NodeJS.ProcessEnv,
  host: ProjectHost,
): { readonly journey: 'architecture-live-review'; readonly directory: HostPath } {
  const journey = environment['HVIR_UX_WALKTHROUGH']
  const directory = environment['HVIR_UX_WALKTHROUGH_DIR']
  if (journey !== 'architecture-live-review')
    throw new Error(`Unsupported UX walkthrough journey: ${journey ?? 'missing'}`)
  if (!directory || !isAbsolute(directory))
    throw new Error('HVIR_UX_WALKTHROUGH_DIR must be an absolute path')
  return { journey, directory: hostPath(host.hostId, directory) }
}

export async function beginUxWalkthrough(
  host: ProjectHost,
  root: HostPath,
  directory: HostPath,
  journey: string,
): Promise<UxWalkthroughManifest> {
  const created = await host.exec('mkdir', ['-p', directory.path], { cwd: root })
  if (created.code !== 0)
    throw new Error(`UX walkthrough artifact directory failed: ${created.stderr}`)
  const manifest: UxWalkthroughManifest = {
    schemaVersion: 1,
    journey,
    startedAt: new Date().toISOString(),
    steps: [],
  }
  await writeManifest(host, directory, manifest)
  return manifest
}

export async function captureUxWalkthroughStep(
  host: ProjectHost,
  win: BrowserWindow,
  directory: HostPath,
  manifest: UxWalkthroughManifest,
  step: { readonly id: string; readonly title: string },
): Promise<UxWalkthroughManifest> {
  await win.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
  const sequence = String(manifest.steps.length + 1).padStart(2, '0')
  const screenshot = `${sequence}-${step.id}.png`
  const note = `${sequence}-${step.id}.json`
  const capturedAt = new Date().toISOString()
  const state = await captureVisibleState(win)
  const image = await win.webContents.capturePage()
  await Promise.all([
    host.writeFile(joinHostPath(directory, screenshot), image.toPNG()),
    host.writeFile(
      joinHostPath(directory, note),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          journey: manifest.journey,
          step: { id: step.id, title: step.title },
          capturedAt,
          state,
        },
        null,
        2,
      )}\n`,
    ),
  ])
  const next: UxWalkthroughManifest = {
    ...manifest,
    steps: [...manifest.steps, { ...step, screenshot, note, capturedAt }],
  }
  await writeManifest(host, directory, next)
  return next
}

export async function completeUxWalkthrough(
  host: ProjectHost,
  directory: HostPath,
  manifest: UxWalkthroughManifest,
): Promise<UxWalkthroughManifest> {
  const completed = { ...manifest, completedAt: new Date().toISOString() }
  await writeManifest(host, directory, completed)
  return completed
}

async function captureVisibleState(win: BrowserWindow): Promise<unknown> {
  return await win.webContents.executeJavaScript(`
    (() => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const name = (node) => node.getAttribute('aria-label') || node.textContent?.trim() || node.getAttribute('placeholder') || '';
      const extent = (selector) => {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) return null;
        return {
          selector,
          clientWidth: node.clientWidth,
          clientHeight: node.clientHeight,
          scrollWidth: node.scrollWidth,
          scrollHeight: node.scrollHeight,
          scrollLeft: node.scrollLeft,
          scrollTop: node.scrollTop,
        };
      };
      const surface = document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      const canvas = surface?.querySelector('.architecture-map-canvas');
      const surfaceBounds = surface?.getBoundingClientRect();
      const canvasBounds = canvas?.getBoundingClientRect();
      const timings = [...document.querySelectorAll('table[aria-label="Scan timings"] tbody tr')].map((row) =>
        [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim() || ''),
      );
      return {
        location: document.title,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        controls: [...document.querySelectorAll('button, input, select, summary')]
          .filter(visible)
          .map((node) => ({
            element: node.tagName.toLowerCase(),
            name: name(node).slice(0, 160),
            disabled: 'disabled' in node ? Boolean(node.disabled) : false,
            pressed: node.getAttribute('aria-pressed'),
            expanded: node.getAttribute('aria-expanded'),
          })),
        scrollExtents: [
          extent('.architecture-review'),
          extent('.architecture-review-body'),
          extent('.architecture-map-scroll'),
          extent('.architecture-explanation'),
        ].filter(Boolean),
        architecture: surface ? {
          timeline: surface.querySelector('.architecture-review-timeline label')?.textContent?.trim() || null,
          metadata: surface.querySelector('.architecture-review-metadata summary')?.textContent?.trim() || null,
          alert: surface.querySelector('[role="alert"]')?.textContent?.trim() || null,
          status: surface.querySelector('[role="status"]')?.textContent?.trim() || null,
          mapVisible: Boolean(surface.querySelector('.architecture-review-map')),
          mapExpanded: surface.querySelector('[aria-label="Collapse architecture map"]')?.getAttribute('aria-expanded') === 'true',
          canvas: surfaceBounds && canvasBounds ? {
            width: canvasBounds.width,
            height: canvasBounds.height,
            visibleHeight: Math.max(0, Math.min(canvasBounds.bottom, surfaceBounds.bottom) - Math.max(canvasBounds.top, surfaceBounds.top)),
            surfaceHeight: surfaceBounds.height,
            heightRatio: canvasBounds.height / surfaceBounds.height,
          } : null,
          nodeCount: surface.querySelectorAll('.architecture-canvas-node').length,
          systemCount: surface.querySelectorAll('.architecture-canvas-system').length,
          subsystemCount: surface.querySelectorAll('.architecture-canvas-subsystem').length,
        } : null,
        timings,
      };
    })()
  `)
}

async function writeManifest(
  host: ProjectHost,
  directory: HostPath,
  manifest: UxWalkthroughManifest,
): Promise<void> {
  await host.writeFile(
    joinHostPath(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}
