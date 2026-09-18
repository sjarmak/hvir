import type { BrowserWindow } from 'electron'

import type { HostPath, ProjectState } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { SmokeAttention } from './attention-smoke'
import { verifyAttentionAwayThrottlingScenario } from './attention-away-throttling'
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
  readonly resources: Pick<RendererResourceScopes, 'currentOwner'>
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
  }
}
