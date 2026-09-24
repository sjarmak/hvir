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
    win.setContentSize(1280, 900)
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
          const collapsedWidth = map.getBoundingClientRect().width;
          const collapsedViewport = map.querySelector('.architecture-map-scroll')?.getBoundingClientRect().height ?? 0;
          const surface = document.querySelector('.architecture-review');
          if (!(surface instanceof HTMLElement)) return reject(new Error('Architecture surface disappeared'));
          const visibleHeight = (element) => {
            const elementRect = element.getBoundingClientRect();
            const surfaceRect = surface.getBoundingClientRect();
            return Math.max(0, Math.min(elementRect.bottom, surfaceRect.bottom) - Math.max(elementRect.top, surfaceRect.top));
          };
          const collapsedVisible = visibleHeight(map.querySelector('.architecture-map-scroll'));
          button.click();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const expandedWidth = map.getBoundingClientRect().width;
            const expandedHeight = map.getBoundingClientRect().height;
            const expandedViewport = map.querySelector('.architecture-map-scroll')?.getBoundingClientRect().height ?? 0;
            if (button.getAttribute('aria-expanded') !== 'true' || !map.classList.contains('architecture-map-expanded')) {
              return reject(new Error('Architecture map did not enter expanded state'));
            }
            if (expandedWidth <= collapsedWidth * 1.5) {
              return reject(new Error('Expanded architecture map did not occupy more space'));
            }
            if (expandedHeight < surface.getBoundingClientRect().height * 0.9) {
              return reject(new Error('Expanded architecture viewport geometry: ' + JSON.stringify({ expandedHeight, surfaceHeight: surface.getBoundingClientRect().height, expandedViewport, collapsedViewport, visible: visibleHeight(map.querySelector('.architecture-map-scroll')), collapsedVisible })));
            }
            if (visibleHeight(map.querySelector('.architecture-map-scroll')) <= collapsedVisible) {
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
      joinHostPath(directory, '1280-expanded-dark.png'),
      expandedImage.toPNG(),
    )
    console.log('[smoke] expanded architecture artifact: ' + directory.path)
    if (expansionError) throw expansionError
    await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const map = document.querySelector('.architecture-review-map');
        const button = document.querySelector('[aria-label="Collapse architecture map"]');
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
