// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { captureUxWalkthroughStep } from '../src/main/smoke/ux-walkthrough-artifacts'
import type { ProjectHost } from '../src/main/project-host'
import { localPath } from '../src/shared'

it('records the expanded explanation panel state', async () => {
  document.body.innerHTML = `
    <main aria-label="Architecture review">
      <section class="architecture-explanation">
        <header>
          <h3>Explanation</h3>
          <button aria-label="Collapse explanation panel" aria-expanded="true">Collapse</button>
        </header>
        <div>
          <button>Explain this change</button>
        </div>
        <div class="architecture-explanation-launch">Prepared handoff</div>
      </section>
    </main>
  `

  await expect(captureStateFromStep()).resolves.toMatchObject({
    architecture: {
      explanation: {
        collapsed: false,
        explainButtonPresent: true,
        headerOnly: false,
        status: 'prepared',
      },
    },
  })
})

it('records that a collapsed explanation panel contains only its header', async () => {
  document.body.innerHTML = `
    <main aria-label="Architecture review">
      <section class="architecture-explanation">
        <header>
          <h3>Explanation</h3>
          <button aria-label="Expand explanation panel" aria-expanded="false">Expand</button>
        </header>
      </section>
    </main>
  `

  await expect(captureStateFromStep()).resolves.toMatchObject({
    architecture: {
      explanation: {
        collapsed: true,
        explainButtonPresent: false,
        headerOnly: true,
        status: 'collapsed',
      },
    },
  })
})

function browserWindow(): BrowserWindow {
  return {
    webContents: {
      executeJavaScript: (script: string) => Promise.resolve(globalThis.eval(script)),
      capturePage: () => Promise.resolve({ toPNG: () => Buffer.from('image') }),
    },
  } as unknown as BrowserWindow
}

async function captureStateFromStep(): Promise<unknown> {
  const writeFile = vi.fn<ProjectHost['writeFile']>(() => Promise.resolve())
  await captureUxWalkthroughStep(
    { writeFile } as unknown as ProjectHost,
    browserWindow(),
    localPath('/artifacts'),
    {
      schemaVersion: 1,
      journey: 'architecture-live-review',
      startedAt: '2026-09-27T00:00:00.000Z',
      steps: [],
    },
    { id: 'explanation', title: 'Explanation' },
  )
  const note = writeFile.mock.calls.find(([path]) =>
    path.path.endsWith('01-explanation.json'),
  )
  if (!note || typeof note[1] !== 'string')
    throw new Error('Walkthrough note was not written')
  return (JSON.parse(note[1]) as { readonly state: unknown }).state
}
