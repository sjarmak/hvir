import type { BrowserWindow } from 'electron'

import type { HostPath, ProjectState, TerminalRecoverySession } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { SmokeAttention } from './attention-smoke'
import { verifyAttentionAwayThrottlingScenario } from './attention-away-throttling'
import { verifyCompanionMirrorAwayScenario } from './companion-mirror-away'
import { verifyCompanionPromptAwayScenario } from './companion-prompt-away'
import type { SmokeCompanion } from './companion-smoke'
import type { TerminalMoveSmokeHarness } from './terminal-move'
import {
  verifyAppSettingsScenario,
  verifyHarnessProfilesScenario,
  verifyTerminalMoveScenario,
  verifyTerminalSplitScenario,
  verifyTerminalThemeScenario,
  verifyWorkbenchLayoutScenario,
} from './terminal-presentation-scenarios'

export interface TerminalScenarioTableOptions {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly host: ProjectHost
  readonly smokeRoot: HostPath
  readonly harness: TerminalMoveSmokeHarness
  readonly emitState: (state: ProjectState) => void
  readonly attention: SmokeAttention
  readonly resources: Pick<RendererResourceScopes, 'currentOwner' | 'isCurrent'>
  readonly companion: SmokeCompanion
  readonly addRetained: (root: HostPath, session: TerminalRecoverySession) => void
}

/** The terminal presentation scenarios, keyed by smoke mode, over one live window. */
export function terminalScenarioTable({
  win,
  supervisor,
  host,
  smokeRoot,
  harness,
  emitState,
  attention,
  resources,
  companion,
  addRetained,
}: TerminalScenarioTableOptions): Readonly<Record<string, () => Promise<void>>> {
  return {
    'terminal-theme': () => verifyTerminalThemeScenario(win, supervisor),
    'terminal-move': () =>
      verifyTerminalMoveScenario({ win, supervisor, harness, emitState }),
    'workbench-layout': () => verifyWorkbenchLayoutScenario(win, supervisor),
    'terminal-split': () => verifyTerminalSplitScenario(win, supervisor),
    'app-settings': () => verifyAppSettingsScenario(win, supervisor),
    'harness-profiles': () =>
      verifyHarnessProfilesScenario(win, supervisor, host, smokeRoot),
    'attention-away-throttling': async () => {
      await verifyAttentionAwayThrottlingScenario({
        win,
        supervisor,
        attention,
        resources,
      })
    },
    'companion-mirror-away': async () => {
      const result = await verifyCompanionMirrorAwayScenario({
        win,
        supervisor,
        attention,
        resources,
        companion,
        smokeRoot,
        addRetained,
      })
      console.log(`[smoke] companion mirror away OK (${result})`)
    },
    'companion-prompt-away': async () => {
      const result = await verifyCompanionPromptAwayScenario({
        win,
        supervisor,
        attention,
        resources,
        companion,
        smokeRoot,
        addRetained,
      })
      console.log(`[smoke] companion prompt away OK (${result})`)
    },
  }
}
