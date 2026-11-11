import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    on: vi.fn(),
    off: vi.fn(),
  },
  BrowserWindow: class {
    constructor() {
      const window = new FakeWindow()
      electron.windows.push(window)
      return window
    }
  },
  dialog: { showMessageBox: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn() },
}))

import { createElectronWindowManager } from '../src/main/window/electron-window-manager'

class FakeWebContents extends EventEmitter {
  readonly id = 41
  readonly mainFrame = { isDestroyed: () => false, postMessage: vi.fn() }
  readonly setWindowOpenHandler = vi.fn()
  readonly getOSProcessId = vi.fn(() => 10)
  readonly isCrashed = vi.fn(() => false)
  readonly reload = vi.fn()
  readonly forcefullyCrashRenderer = vi.fn()
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
  readonly loadFile = vi.fn(() => Promise.resolve())
  readonly loadURL = vi.fn(() => Promise.resolve())
  readonly show = vi.fn()
  readonly isFocused = vi.fn(() => true)
  readonly isDestroyed = vi.fn(() => false)
}

const buildConfig = readFileSync(
  new URL('../electron.vite.config.ts', import.meta.url),
  'utf8',
)
const smokeComposition = readFileSync(
  new URL('../src/main/smoke/index.ts', import.meta.url),
  'utf8',
)
const appSettings = readFileSync(
  new URL('../src/main/smoke/app-settings.ts', import.meta.url),
  'utf8',
)
const terminalThemeGallery = readFileSync(
  new URL('../src/main/smoke/terminal-theme-gallery-presentation.ts', import.meta.url),
  'utf8',
)
const sessionNaming = readFileSync(
  new URL('../src/main/smoke/session-naming.ts', import.meta.url),
  'utf8',
)
const agentReportNavigation = readFileSync(
  new URL('../src/main/smoke/agent-report-navigation.ts', import.meta.url),
  'utf8',
)
describe('smoke regression contracts', () => {
  it('builds every main-process entry exercised by smoke scenarios', () => {
    expect(buildConfig).toContain("'agent-cli': resolve('src/agent-cli/index.ts')")
  })

  it('routes renderer calls to the production-composed smoke runtimes', () => {
    expect(smokeComposition).toContain('agents: dependencies.agents,')
    expect(smokeComposition).toContain('extensions: dependencies.extensions,')
  })

  it('starts extension IPC owners before the smoke renderer can query them', () => {
    expect(smokeComposition.indexOf('await prepareExtensionSmoke(')).toBeGreaterThan(-1)
    expect(smokeComposition.indexOf('await prepareExtensionSmoke(')).toBeLessThan(
      smokeComposition.indexOf('await createSmokeWindow('),
    )
  })

  it('accepts the complete seven-section settings surface', () => {
    expect(appSettings).toContain('sections.length !== 7')
    expect(appSettings).toContain(
      "resolve('7 sections · modal isolation · validation focus')",
    )
  })

  it('waits for restarted settings to close before naming a session', () => {
    expect(terminalThemeGallery).toContain(
      "if (!document.querySelector('.settings-dialog')) return resolve('Catppuccin Mocha + Alabaster')",
    )
  })

  it('holds the automatic title until every naming surface observes it', () => {
    expect(sessionNaming).toContain('IFS= read -r hvir_naming_continue')
  })

  it('selects Git by identity when extension project tabs follow it', () => {
    expect(agentReportNavigation).toContain(
      ".find(button => button.textContent?.trim().startsWith('Git'))",
    )
    expect(agentReportNavigation).not.toContain(
      `nav[aria-label="Project views"] button:last-child`,
    )
  })

  it('binds extension foreground authority to native window focus', () => {
    electron.windows.length = 0
    const owner = { id: 41, generation: 1 }
    const installWindowLifecycle = vi.fn(
      (_window: unknown, _getOwner: () => typeof owner) => undefined,
    )
    const manager = createElectronWindowManager({
      extensionGuests: { installWindowLifecycle } as never,
      htmlPreviews: { releaseOwner: vi.fn() } as never,
      activateRenderer: vi.fn(() => owner),
      rolloverRenderer: vi.fn(() => ({ ...owner, generation: 2 })),
      revokeRenderer: vi.fn(),
      isRendererCurrent: vi.fn(() => true),
      resumeRendererIpc: vi.fn(),
      setOwnerFocused: vi.fn(),
      startRendererDiagnostics: vi.fn(() => ({
        version: 1 as const,
        ownerGeneration: 1,
        sessionId: 'diagnostic',
      })),
      rendererReady: vi.fn(),
      recordWindowHealth: vi.fn(),
      onLastWindowClosed: vi.fn(),
      isShuttingDown: vi.fn(() => false),
    })

    const win = manager.createWindow()

    expect(win).toBe(electron.windows[0])
    expect(installWindowLifecycle).toHaveBeenCalledOnce()
    expect(installWindowLifecycle).toHaveBeenCalledWith(win, expect.any(Function))
    expect(installWindowLifecycle.mock.calls[0]?.[1]()).toBe(owner)
  })
})
