import { hostPath, joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { BrowserWindow } from 'electron'

/** Real Chromium layout and theme checks with disposable visual artifacts. */
export async function verifyArchitectureReviewVisuals(
  win: BrowserWindow,
  host: ProjectHost,
  root: HostPath,
): Promise<void> {
  const size = win.getContentSize()
  const theme = (await win.webContents.executeJavaScript(
    'document.documentElement.dataset.theme',
  )) as string | undefined
  const created = await host.exec(
    'mktemp',
    ['-d', '-t', 'hvir-architecture-visual-XXXXXX'],
    { cwd: root },
  )
  if (created.code !== 0)
    throw new Error('Architecture visual directory failed: ' + created.stderr)
  const directory = hostPath(host.hostId, created.stdout.trim())
  const backgrounds = new Set<string>()
  try {
    for (const width of [1280, 760]) {
      win.setContentSize(width, 900)
      for (const variant of ['light', 'dark']) {
        const background = (await win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            document.documentElement.dataset.theme = ${JSON.stringify(variant)};
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const surface = document.querySelector('.architecture-review');
              const body = document.querySelector('.architecture-review-body');
              if (!surface || !body) return reject(new Error('Architecture surface disappeared'));
              if (body.scrollWidth > body.clientWidth + 2) return reject(new Error('Architecture review overflows at ' + innerWidth));
              if (innerWidth <= 900 && getComputedStyle(body).flexDirection !== 'column') return reject(new Error('Narrow architecture layout did not stack'));
              resolve(getComputedStyle(surface).backgroundColor);
            }));
          })
        `)) as string
        backgrounds.add(background)
        const image = await win.webContents.capturePage()
        await host.writeFile(
          joinHostPath(directory, `${width}-${variant}.png`),
          image.toPNG(),
        )
      }
    }
    if (backgrounds.size !== 2)
      throw new Error('Architecture light/dark themes did not change computed colors')
    win.setContentSize(1440, 1000)
    let expansionError: Error | undefined
    try {
      await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        requestAnimationFrame(() => {
          const body = document.querySelector('.architecture-review-body');
          const map = document.querySelector('.architecture-review-map');
          const button = document.querySelector('[aria-label="Expand architecture map"]');
          if (!(body instanceof HTMLElement) || !(map instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
            return reject(new Error('Architecture map expansion controls disappeared'));
          }
          const toggleRect = button.getBoundingClientRect();
          const mapRect = map.getBoundingClientRect();
          if (button.textContent.trim() !== '+' || mapRect.right - toggleRect.right > 20 || toggleRect.top - mapRect.top > 24) {
            return reject(new Error('Map expand control is not a top-right plus'));
          }
          const collapsedWidth = map.getBoundingClientRect().width;
          const collapsedHeight = map.getBoundingClientRect().height;
          const canvas = map.querySelector('.architecture-map-canvas');
          if (!(canvas instanceof HTMLElement)) return reject(new Error('Architecture canvas disappeared'));
          const collapsedViewport = canvas.getBoundingClientRect().height;
          const surface = document.querySelector('.architecture-review');
          if (!(surface instanceof HTMLElement)) return reject(new Error('Architecture surface disappeared'));
          const visibleHeight = (element) => {
            const elementRect = element.getBoundingClientRect();
            const surfaceRect = surface.getBoundingClientRect();
            return Math.max(0, Math.min(elementRect.bottom, surfaceRect.bottom) - Math.max(elementRect.top, surfaceRect.top));
          };
          const collapsedVisible = visibleHeight(canvas);
          button.click();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const expandedWidth = map.getBoundingClientRect().width;
            const expandedHeight = map.getBoundingClientRect().height;
            const expandedViewport = canvas.getBoundingClientRect().height;
            const surfaceRect = surface.getBoundingClientRect();
            const mapRect = map.getBoundingClientRect();
            if (Math.abs(mapRect.top - surfaceRect.top) > 2 || Math.abs(mapRect.bottom - surfaceRect.bottom) > 2) {
              return reject(new Error('Expanded map does not fill the file view height'));
            }
            if (Array.from(surface.children).some(child => child !== body && getComputedStyle(child).display !== 'none')) {
              return reject(new Error('Surrounding review panels remain visible in expanded map'));
            }
            if (button.textContent.trim() !== '−') return reject(new Error('Expanded map needs a minus control'));
            const nodeCount = canvas.querySelectorAll('.architecture-canvas-node').length;
            if (button.getAttribute('aria-expanded') !== 'true' || !map.classList.contains('architecture-map-expanded')) {
              return reject(new Error('Architecture map did not enter expanded state'));
            }
            if (expandedWidth <= collapsedWidth * 1.5) {
              return reject(new Error('Expanded architecture map did not occupy more space'));
            }
            if (expandedHeight < collapsedHeight) {
              return reject(new Error('Expanded architecture viewport geometry: ' + JSON.stringify({ expandedHeight, surfaceHeight: surface.getBoundingClientRect().height, expandedViewport, collapsedViewport, visible: visibleHeight(canvas), collapsedVisible })));
            }
            if (expandedViewport < surface.getBoundingClientRect().height * 0.6 || nodeCount === 0) {
              return reject(new Error('Expanded architecture canvas geometry: ' + JSON.stringify({ canvasHeight: expandedViewport, surfaceHeight: surface.getBoundingClientRect().height, ratio: expandedViewport / surface.getBoundingClientRect().height, nodeCount })));
            }
            if (visibleHeight(canvas) <= collapsedVisible) {
              return reject(new Error('Expanded architecture graph did not gain visible review space'));
            }
            resolve(true);
          }));
        });
      })
    `)
    } catch (error) {
      expansionError = error instanceof Error ? error : new Error(String(error))
    }
    const expandedImage = await win.webContents.capturePage()
    await host.writeFile(
      joinHostPath(directory, '1440-expanded-dark.png'),
      expandedImage.toPNG(),
    )
    console.log('[smoke] expanded architecture artifact: ' + directory.path)
    if (expansionError) throw expansionError
    await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        document.querySelector('[aria-label="Collapse architecture map"]')?.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const button = document.querySelector('[aria-label="Expand architecture map"]');
          const header = document.querySelector('.architecture-review-header');
          const map = document.querySelector('.architecture-review-map');
          const body = document.querySelector('.architecture-review-body');
          if (!button || button.textContent.trim() !== '+' || !header || getComputedStyle(header).display === 'none') {
            return reject(new Error('Minus did not restore the review controls'));
          }
          if (!map || !body || map.getBoundingClientRect().width >= body.getBoundingClientRect().width * 0.9) {
            return reject(new Error('Minus did not restore the split review layout'));
          }
          resolve(true);
        }));
      })
    `)
    await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const map = document.querySelector('.architecture-review-map');
        const button = document.querySelector('[aria-label="Expand architecture map"]');
        const explorer = document.querySelector('.architecture-file-explorer');
        if (!(map instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || !(explorer instanceof HTMLDetailsElement)) {
          return reject(new Error('Architecture expanded review controls disappeared'));
        }
        explorer.open = true;
        explorer.querySelector('button.architecture-module')?.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
              if (button.getAttribute('aria-expanded') !== 'false' || map.classList.contains('architecture-map-expanded')) {
                return reject(new Error('Architecture map did not collapse'));
              }
              const deadline = performance.now() + 2000;
              const checkEvidence = () => {
                const evidence = document.querySelector('.architecture-evidence');
                if (evidence && getComputedStyle(evidence).display !== 'none') return resolve(true);
                if (performance.now() >= deadline) {
                  return reject(new Error('Architecture evidence did not become visible after file selection'));
                }
                window.setTimeout(checkEvidence, 50);
              };
              checkEvidence();
            }));
      })
    `)
    console.log(`[smoke] architecture visual artifacts: ${directory.path}`)
  } finally {
    win.setContentSize(size[0]!, size[1]!)
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme = ${JSON.stringify(theme ?? 'dark')}`,
    )
  }
}
