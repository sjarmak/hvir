import type { BrowserWindow } from 'electron'

import type { HostPath, ProjectState } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
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
}

/** The terminal presentation scenarios, keyed by smoke mode, over one live window. */
export function terminalScenarioTable({
  win,
  supervisor,
  host,
  smokeRoot,
  harness,
  emitState,
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
  }
}
