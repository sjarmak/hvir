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
    console.log(`[smoke] architecture visual artifacts: ${directory.path}`)
  } finally {
    win.setContentSize(size[0]!, size[1]!)
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme = ${JSON.stringify(theme ?? 'dark')}`,
    )
  }
}
