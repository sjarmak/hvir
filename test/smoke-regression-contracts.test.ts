import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const buildConfig = readFileSync(new URL('../electron.vite.config.ts', import.meta.url), 'utf8')
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
const electronWindowManager = readFileSync(
  new URL('../src/main/window/electron-window-manager.ts', import.meta.url),
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
    expect(appSettings).toContain("resolve('7 sections · modal isolation · validation focus')")
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
    expect(electronWindowManager).toContain(
      'dependencies.extensionGuests?.installWindowLifecycle(win, () => rendererOwner)',
    )
  })
})
