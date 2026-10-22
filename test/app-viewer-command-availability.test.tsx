// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  reportActive: true,
  commandPorts: undefined as
    | { readonly canUseViewerCommands: () => boolean }
    | undefined,
}))

vi.mock('../src/renderer/src/theme', () => ({
  setAppTheme: vi.fn(),
  useAppTheme: () => 'dark',
}))

vi.mock('../src/renderer/src/settings/settings', () => ({
  setAppSettings: vi.fn(),
  terminalPreferences: vi.fn(),
  useAppSettings: () => ({
    composerSubmitMode: 'enter',
    gitAutoFetchIntervalMs: 0,
    keybindings: {},
  }),
}))

vi.mock('../src/renderer/src/architecture-review/use-architecture-review-tab', () => ({
  useArchitectureReviewTab: () => ({
    active: () => false,
    close: vi.fn(),
    deactivate: vi.fn(),
    open: vi.fn(),
  }),
}))

vi.mock('../src/renderer/src/workbench/use-workbench-overlays', () => ({
  useWorkbenchOverlays: () => ({
    closeSettings: vi.fn(),
    openAddHarnessSettings: vi.fn(),
    openSettings: vi.fn(),
    projectPickerOpen: false,
    settingsOpen: false,
  }),
}))

vi.mock('../src/renderer/src/workspaces/use-external-attention', () => ({
  useExternalAttention: () => ({}),
}))

vi.mock('../src/renderer/src/terminal/use-terminal-attention', () => ({
  useTerminalAttention: () => ({}),
}))

vi.mock('../src/renderer/src/extensions/use-extension-views', () => ({
  useExtensionViews: () => ({
    activeRef: { current: false },
    deactivate: vi.fn(),
  }),
}))

vi.mock('../src/renderer/src/viewer/use-viewer-workspace', () => ({
  useViewerWorkspace: () => ({
    activeTab: undefined,
    cycleActiveMode: vi.fn(),
    deactivateReport: vi.fn(),
    focusPane: vi.fn(),
    getActivePane: () => 'primary',
    handleWatchEvent: vi.fn(),
    isReportActive: () => state.reportActive,
    openFile: vi.fn(),
    openWatchPaths: [],
    reloadCleanFiles: vi.fn(),
    renderedWatchPaths: [],
    switchWorkspace: vi.fn(),
    tabs: [],
    viewerCommands: {
      findInFile: vi.fn(),
      goToLine: vi.fn(),
    },
  }),
}))

vi.mock('../src/renderer/src/document-review/use-document-review-workspace', () => ({
  useReviewWorkspace: () => ({ watchPaths: [] }),
  useWatchFanout: () => ({ handle: vi.fn() }),
}))

vi.mock('../src/renderer/src/dashboards/use-web-pane-workspace', () => ({
  useWebPaneWorkspace: () => ({
    activeRef: { current: false },
    applyProjectState: () => false,
    closeView: vi.fn(),
    forgetTerminalViews: vi.fn(),
    setActive: vi.fn(),
    setFocused: vi.fn(),
    setWorkspaceRoot: vi.fn(),
  }),
}))

vi.mock('../src/renderer/src/workspaces/project-session', () => ({
  useProjectSession: () => ({
    acceptProjectState: vi.fn(),
    acknowledgeWorkspaces: vi.fn(),
    activeWorkspace: undefined,
    connectionState: 'connected',
    projectState: undefined,
    prompts: [],
    refreshGit: vi.fn(),
    refreshWorkspaceContent: vi.fn(),
    reportError: vi.fn(),
    root: undefined,
    rootError: undefined,
    switchRelativeWorkspace: vi.fn(),
    switchWorkspace: vi.fn(),
    versions: { content: 0, git: 0, ignored: 0, watch: 0 },
  }),
}))

vi.mock('../src/renderer/src/workspaces/project-watch-interests', () => ({
  useProjectWatchInterests: () => ({
    limited: false,
    updateExpandedPath: vi.fn(),
  }),
}))

vi.mock('../src/renderer/src/workbench/use-renderer-ready', () => ({
  useRendererReady: vi.fn(),
}))

vi.mock('../src/renderer/src/git/git-capability', () => ({
  workspaceGitEnabled: () => false,
}))

vi.mock('../src/renderer/src/terminal/use-terminal-workspace-runtime', () => ({
  useTerminalWorkspaceRuntime: () => ({
    openTerminalSearch: vi.fn(),
    sessionsProjection: {},
  }),
}))

vi.mock('../src/renderer/src/workbench/use-workbench-layout', () => ({
  useWorkbenchLayout: () => ({
    focusFilenameSearch: vi.fn(),
    focusTerminal: vi.fn(),
    focusTree: vi.fn(),
    focusViewer: vi.fn(),
    railMode: 'files',
    restoreViewer: vi.fn(),
    setRailMode: vi.fn(),
    setTerminalHeight: vi.fn(),
    setTerminalMode: vi.fn(),
    setTreeCollapsed: vi.fn(),
    setTreeWidth: vi.fn(),
    terminalMode: 'restored',
    toggleTerminalFocus: vi.fn(),
    treeCollapsed: false,
    workbenchRef: { current: null },
  }),
}))

vi.mock('../src/renderer/src/git/use-git-workspace', () => ({
  useGitWorkspace: () => ({
    deactivateGraph: vi.fn(),
    fetch: vi.fn(),
    graphActive: false,
    graphActiveRef: { current: false },
    openGraph: vi.fn(),
    pull: vi.fn(),
    resetGraph: vi.fn(),
    switchBranch: vi.fn(),
  }),
}))

vi.mock('../src/renderer/src/workbench/use-terminal-path-activation', () => ({
  useTerminalPathActivation: () => ({
    activate: vi.fn(),
    revealRequest: undefined,
  }),
}))

vi.mock('../src/renderer/src/terminal/use-terminal-commands', () => ({
  useTerminalCommands: () => ({}),
}))

vi.mock('../src/renderer/src/rail/RailExtensions', () => ({
  RailPanels: () => null,
  RailTabs: () => null,
  useRailExtensions: () => ({ beads: { beadsEnabled: false } }),
}))

vi.mock('../src/renderer/src/needs-you/use-application-navigation', () => ({
  useApplicationNavigation: () => ({
    beadTarget: undefined,
    destination: 'workspace',
    needsYou: {},
    setDestination: vi.fn(),
  }),
}))

vi.mock('../src/renderer/src/workbench/use-workbench-commands', () => ({
  useWorkbenchCommands: (
    _keybindings: unknown,
    ports: { readonly canUseViewerCommands: () => boolean },
  ) => {
    state.commandPorts = ports
  },
}))

import { App } from '../src/renderer/src/App'

afterEach(() => {
  state.reportActive = true
  state.commandPorts = undefined
  document.body.replaceChildren()
})

it('blocks viewer commands while the report overlay is active', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  act(() => root.render(<App />))

  expect(state.commandPorts?.canUseViewerCommands()).toBe(false)
  state.reportActive = false
  expect(state.commandPorts?.canUseViewerCommands()).toBe(true)

  act(() => root.unmount())
})
