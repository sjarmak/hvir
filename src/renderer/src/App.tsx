import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  GIT_CHANGE_DISPLAY_LIMIT,
  hostPathEquals,
  type GitChanges,
  type HostPath,
  type ProjectState,
} from '../../shared'
import { PaneResizer } from './layout/PaneResizer'
import type { WebViewState } from './dashboards/WebPane'
import { revealWebSourceTerminal } from './dashboards/reveal-web-source-terminal'
import { WebPaneStack } from './dashboards/WebPaneStack'
import { useWebPaneWorkspace } from './dashboards/use-web-pane-workspace'
import { TerminalWorkspaceCollection } from './terminal/TerminalWorkspaceCollection'
import { useTerminalWorkspaceRuntime } from './terminal/use-terminal-workspace-runtime'
import { useTerminalAttention } from './terminal/use-terminal-attention'
import { ProjectsBar } from './workspaces/ProjectsBar'
import { useExternalAttention } from './workspaces/use-external-attention'
import { MissingWorkspaceNotice } from './workspaces/MissingWorkspaceNotice'
import { useProjectSession } from './workspaces/project-session'
import { useProjectWatchInterests } from './workspaces/project-watch-interests'
import { SessionDialog } from './workspaces/SessionDialog'
import { SshPromptDialog } from './workspaces/SshPromptDialog'
import { FileTree } from './tree/FileTree'
import { isGitIgnoreRulePath } from './tree/git-ignore-refresh'
import { BeadsRailPanel, BeadsRailTab, useBeadsWorkspace } from './beads/BeadsRail'
import { useTerminalCommands } from './terminal/use-terminal-commands'
import { GitPanel } from './git/GitPanel'
import { workspaceGitEnabled } from './git/git-capability'
import { GitGraphView } from './git/GitGraphView'
import { useArchitectureReviewTab } from './architecture-review/use-architecture-review-tab'
import { useGitWorkspace } from './git/use-git-workspace'
import { FileViewer } from './viewer/FileViewer'
import { TabStrip } from './viewer/TabStrip'
import { useViewerWorkspace } from './viewer/use-viewer-workspace'
import { setAppTheme, useAppTheme } from './theme'
import { SettingsDialog } from './settings/SettingsDialog'
import { setAppSettings, terminalPreferences, useAppSettings } from './settings/settings'
import { useWorkbenchCommands } from './workbench/use-workbench-commands'
import { focusVisibleActiveTerminalAfterLayout } from './workbench/active-terminal-focus'
import { useWorkbenchLayout } from './workbench/use-workbench-layout'
import { useWorkbenchOverlays } from './workbench/use-workbench-overlays'
import { TerminalLayoutControls } from './workbench/TerminalLayoutControls'
import { useRendererReady } from './workbench/use-renderer-ready'
import { useTerminalPathActivation } from './workbench/use-terminal-path-activation'
import * as review from './document-review/use-document-review-workspace'
import { SessionsApplicationDestination } from './sessions/SessionsApplicationDestination'
export function App(): ReactElement {
  const [destination, setDestination] = useState<'workspace' | 'sessions'>('workspace')
  const theme = useAppTheme()
  const settings = useAppSettings()
  const rootRef = useRef<HostPath | undefined>(undefined)
  const workspaceSwitchRef = useRef<(direction: -1 | 1) => void>(() => undefined)
  const sessionErrorRef = useRef<(message: string) => void>(() => undefined)
  const restoreViewerRef = useRef<() => void>(() => undefined)
  const resetGitGraphRef = useRef<() => void>(() => undefined)
  const deactivateGitGraphRef = useRef<() => void>(() => undefined)
  const deactivateWebPaneRef = useRef<() => void>(() => undefined)
  const [gitChanges, setGitChanges] = useState<GitChanges>()
  const architecture = useArchitectureReviewTab({
    root: rootRef,
    activateViewer: () => {
      deactivateGitGraphRef.current()
      deactivateWebPaneRef.current()
      viewer.focusPane('primary')
      restoreViewerRef.current()
    },
  })
  const overlays = useWorkbenchOverlays()
  const externalAttention = useExternalAttention()
  const terminalAttention = useTerminalAttention()
  const viewer = useViewerWorkspace({
    onActivateFile: () => {
      architecture.deactivate()
      deactivateGitGraphRef.current()
      deactivateWebPaneRef.current()
      restoreViewerRef.current()
    },
  })

  const reviewWatch = review.useWatchFanout(viewer.handleWatchEvent)
  const web = useWebPaneWorkspace({
    onActivate: () => {
      architecture.deactivate()
      viewer.focusPane('primary')
      deactivateGitGraphRef.current()
      restoreViewerRef.current()
    },
    onError: (message) => sessionErrorRef.current(message),
  })

  const changedCount = gitChanges?.workingTree.length ?? 0
  const changedCountLabel = gitChanges?.workingTreeLimited
    ? `${GIT_CHANGE_DISPLAY_LIMIT.toLocaleString()}+`
    : changedCount.toLocaleString()
  const { switchWorkspace } = viewer
  const { applyProjectState, setWorkspaceRoot } = web
  const { close: closeArchitectureReview } = architecture
  const applyProjectViewState = useCallback(
    (state: ProjectState): void => {
      switchWorkspace(state.root, state.connectionState === 'connected')
      if (!applyProjectState(state, rootRef.current)) return
      resetGitGraphRef.current()
      closeArchitectureReview()
      setGitChanges(undefined)
    },
    [applyProjectState, switchWorkspace, closeArchitectureReview],
  )
  const session = useProjectSession({
    composerSubmitMode: settings.composerSubmitMode,
    onProjectState: applyProjectViewState,
    onReloadFiles: viewer.reloadCleanFiles,
    onWatchEvent: reviewWatch.handle,
    isIgnoreRulePath: isGitIgnoreRulePath,
  })
  const accept = session.acceptProjectState
  const {
    projectState,
    root,
    activeWorkspace,
    connectionState,
    rootError,
    refreshHosts,
  } = session
  const documentReview = review.useReviewWorkspace(activeWorkspace, reviewWatch)
  const { watch: watchVersion, ignored: ignoredRefreshVersion } = session.versions
  const { content: contentVersion, git: gitVersion } = session.versions
  useRendererReady(Boolean(root))
  const watchInterests = useProjectWatchInterests({
    root,
    connected: connectionState === 'connected',
    missing: activeWorkspace?.missing,
    openPaths: viewer.openWatchPaths,
    reviewPaths: documentReview.watchPaths,
    dependencyPaths: viewer.renderedWatchPaths,
  })
  const gitEnabled = workspaceGitEnabled(activeWorkspace)
  const terminalWorkspaces = useTerminalWorkspaceRuntime({
    projectState,
    acceptProjectState: session.acceptProjectState,
    forgetWebViews: web.forgetTerminalViews,
    acknowledgeWorkspaces: session.acknowledgeWorkspaces,
    onError: session.reportError,
  })
  const layout = useWorkbenchLayout({
    root,
    gitAvailable: gitEnabled,
    workspaceMissing: Boolean(activeWorkspace?.missing),
  })
  const {
    workbenchRef,
    viewerGroupsRef,
    railMode,
    setRailMode,
    terminalMode,
    setTerminalMode,
    toggleTerminalFocus,
    restoreViewer,
    treeCollapsed,
    setTreeCollapsed,
    setTreeWidth,
    setTerminalHeight,
    setViewerPrimaryWidth,
    resetViewerPrimaryWidth,
    focusTerminal: showTerminal,
  } = layout
  const git = useGitWorkspace({
    root,
    hasDirtyViewerTabs: () => viewer.tabs.some((tab) => tab.dirty),
    acceptProjectState: session.acceptProjectState,
    refreshContent: session.refreshWorkspaceContent,
    refreshGit: session.refreshGit,
    activateViewer: () => {
      architecture.deactivate()
      viewer.focusPane('primary')
      restoreViewer()
    },
    deactivateWebPane: () => web.setActive(false),
  })
  const {
    graphOpen: gitGraphOpen,
    graphActive: gitGraphActive,
    graphActiveRef: gitGraphActiveRef,
    graphRequest: gitGraphRequest,
    openGraph: openGitGraph,
    activateGraph: activateGitGraph,
    closeGraph: closeGitGraph,
    resetGraph: resetGitGraph,
    deactivateGraph: deactivateGitGraph,
    switchBranch: switchGitBranch,
    fetch: fetchGit,
    pull: pullGit,
  } = git
  const terminalPathActivation = useTerminalPathActivation({
    root,
    selectedFile: viewer.activeTab?.path,
    openFile: (path, position) =>
      viewer.openFile(path, true, 'file-tree', 'head', undefined, position),
    revealDirectory: layout.focusTree,
  })
  rootRef.current = root
  sessionErrorRef.current = session.reportError
  workspaceSwitchRef.current = session.switchRelativeWorkspace
  restoreViewerRef.current = restoreViewer
  resetGitGraphRef.current = resetGitGraph
  deactivateGitGraphRef.current = deactivateGitGraph
  deactivateWebPaneRef.current = () => web.setActive(false)
  const terminalCommands = useTerminalCommands(session.activeWorkspace?.id)
  const beads = useBeadsWorkspace(session, layout, terminalCommands)
  useEffect(() => {
    if (overlays.projectPickerOpen) void refreshHosts()
  }, [overlays.projectPickerOpen, refreshHosts])
  useEffect(() => {
    if (root) setWorkspaceRoot(root)
  }, [root, setWorkspaceRoot])
  useEffect(() => {
    if (activeWorkspace?.missing) resetGitGraph()
  }, [activeWorkspace?.missing, resetGitGraph])
  useWorkbenchCommands(settings.keybindings, {
    enabled: destination === 'workspace',
    closeWebPane: web.closeView,
    escapeWebPaneFocus: () => web.setFocused(false),
    canUseViewerCommands: () =>
      !gitGraphActiveRef.current &&
      !web.activeRef.current &&
      (!root || !architecture.active(root)),
    cycleViewMode: viewer.cycleActiveMode,
    findFile: layout.focusFilenameSearch,
    findInFile: viewer.viewerCommands.findInFile,
    findInTerminal: terminalWorkspaces.openTerminalSearch,
    goToLine: viewer.viewerCommands.goToLine,
    toggleTerminalFocus,
    focusTerminal: layout.focusTerminal,
    focusViewer: () => layout.focusViewer(viewer.getActivePane()),
    focusTree: layout.focusTree,
    switchWorkspace: (direction) => {
      setDestination('workspace')
      workspaceSwitchRef.current(direction)
    },
  })
  const revealSourceTerminal = (view: WebViewState) =>
    revealWebSourceTerminal(view, {
      projectState,
      root: rootRef.current,
      switchWorkspace: session.switchWorkspace,
      onError: session.reportError,
    })
  if (rootError) return <div className="startup-error">{rootError}</div>
  if (!root) return <div className="startup-loading">Starting hvir…</div>
  const rootWebViews = web.views.filter((view) =>
    hostPathEquals(view.workspaceRoot, root),
  )
  const renderViewerPane = (
    pane: 'primary' | 'secondary',
    paneTabs: typeof viewer.primaryTabs,
    paneTab: typeof viewer.primaryActiveTab,
    graphPane: boolean,
  ): ReactElement => (
    <section
      className={`viewer-group viewer-group-${pane}`}
      aria-label={`${pane === 'primary' ? 'Primary' : 'Secondary'} file viewer`}
      data-diagnostic-capture="viewer"
      data-viewer-pane={pane}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (event.button !== 0) return
        if (
          paneTab &&
          !(graphPane && gitGraphActive) &&
          !(pane === 'primary' && web.active) &&
          !architecture.active(root, pane)
        ) {
          viewer.focusPane(pane, paneTab.id)
        } else {
          viewer.focusPane(pane)
        }
      }}
    >
      <TabStrip
        tabs={paneTabs}
        pathCopyRoot={root}
        pane={pane}
        activeId={
          (graphPane && gitGraphActive) ||
          (pane === 'primary' && web.active) ||
          architecture.active(root, pane)
            ? undefined
            : paneTab?.id
        }
        onActivate={(id) => viewer.activateTab(id, pane)}
        onClose={viewer.closeTab}
        onPin={viewer.pinTab}
        onReorder={viewer.reorderTabs}
        onMoveToPane={viewer.moveTab}
        split={viewer.split}
        onSplit={viewer.openSplit}
        onClosePane={pane === 'secondary' ? viewer.closeSplit : undefined}
        graphOpen={graphPane && gitGraphOpen}
        graphActive={graphPane && gitGraphActive}
        onActivateGraph={activateGitGraph}
        onCloseGraph={closeGitGraph}
        {...architecture.stripProps(root, pane)}
        webTabs={
          pane === 'primary'
            ? rootWebViews.map((view) => ({ id: view.id, title: view.title }))
            : undefined
        }
        activeWebId={pane === 'primary' && web.active ? web.activeId : undefined}
        onActivateWeb={web.activateView}
        onCloseWeb={web.closeView}
      />
      {graphPane && gitGraphOpen ? (
        <div className="workspace-view" hidden={!gitGraphActive}>
          <GitGraphView
            root={root}
            refreshVersion={gitVersion}
            connectionState={connectionState}
            requestedHash={gitGraphRequest.hash}
            requestSerial={gitGraphRequest.serial}
            onOpen={(path, base, revision) =>
              viewer.openFile(path, true, 'git', base, revision)
            }
          />
        </div>
      ) : null}
      {architecture.panel(root, pane, session.switchWorkspace)}
      {pane === 'primary' ? (
        <WebPaneStack
          views={web.views}
          root={root}
          active={web.active}
          activeId={web.activeId}
          focused={web.focused}
          onToggleFocus={() => web.setFocused((focused) => !focused)}
          onTitle={web.setTitle}
          onBlockedNavigation={web.followBlockedNavigation}
          onOpenBrowser={web.openBrowser}
          onRevealTerminal={(view) => void revealSourceTerminal(view)}
        />
      ) : null}
      <div
        className="workspace-view"
        hidden={
          (graphPane && gitGraphActive) ||
          (pane === 'primary' && web.active) ||
          architecture.active(root, pane)
        }
      >
        {activeWorkspace?.missing ? (
          <MissingWorkspaceNotice root={root} />
        ) : (
          <FileViewer
            key={`${pane}:${paneTab?.id ?? 'empty'}`}
            tab={paneTab}
            gitRefreshVersion={gitVersion}
            onMode={(mode, at) => paneTab && viewer.setMode(paneTab.id, mode, at)}
            onDiffBase={(diffBase) => paneTab && viewer.setDiffBase(paneTab.id, diffBase)}
            onContent={(content) => paneTab && viewer.setContent(paneTab.id, content)}
            onSave={() => paneTab && viewer.saveTab(paneTab.id)}
            onReload={() => paneTab && viewer.reloadTab(paneTab.id)}
            onPosition={(position) =>
              paneTab && viewer.schedulePosition(paneTab.id, position)
            }
            onNavigationHandled={(serial) =>
              paneTab && viewer.navigationHandled(paneTab.id, serial)
            }
            registerCommands={viewer.viewerCommands.register}
            onOpenPath={(path) => {
              viewer.focusPane(pane)
              if (paneTab) viewer.pinTab(paneTab.id)
              viewer.openFile(path, true)
            }}
            onRenderedDependencies={viewer.setRenderedDependencies}
            documentReview={documentReview}
          />
        )}
      </div>
    </section>
  )
  return (
    <div className="app-shell">
      {projectState ? (
        <ProjectsBar
          state={projectState}
          rollups={terminalAttention.rollups}
          external={externalAttention}
          busy={session.busy}
          onAdd={overlays.openProjectPicker}
          onSwitch={(projectId, workspaceId) => {
            setDestination('workspace')
            void session.switchWorkspace(projectId, workspaceId)
          }}
          onRefresh={(projectId) => void session.refreshProject(projectId)}
          onCloseProject={(projectId) => void session.closeProject(projectId)}
          onPrune={(projectId) => void session.pruneWorktrees(projectId)}
          onDismiss={(projectId, workspaceId) =>
            void session.dismissWorkspace(projectId, workspaceId)
          }
          onPlanCloseWorkspace={session.planWorkspaceClose}
          onCloseWorkspace={(projectId, workspaceId, plan, terminateTerminals) =>
            void session.closeWorkspace(projectId, workspaceId, plan, terminateTerminals)
          }
          onReopenWorkspace={(projectId, workspaceId) =>
            void session.reopenWorkspace(projectId, workspaceId)
          }
          watchTier={session.watchTier}
          statusError={session.error}
          onChangeConnection={overlays.openProjectPicker}
          onDisconnect={() => void session.disconnect()}
          onReconnect={() => void session.reconnect()}
          theme={theme}
          onTheme={(nextTheme) => setAppTheme(nextTheme)}
          onSettings={() => overlays.openSettings()}
          sessionsActive={destination === 'sessions'}
          onSessions={() => setDestination('sessions')}
        />
      ) : null}
      <main
        className={`workbench${connectionState === 'connected' ? '' : ' project-stale'}${terminalMode === 'maximized' ? ' terminal-focused' : ''}${terminalMode === 'collapsed' ? ' terminal-collapsed' : ''}${treeCollapsed ? ' tree-collapsed' : ''}${layout.terminalRailCompact ? ' terminal-rail-compact' : ''}${web.focused && web.active ? ' web-focused' : ''}`}
        ref={workbenchRef}
        hidden={destination === 'sessions'}
      >
        <aside
          className="tree-panel"
          aria-label="Project rail"
          data-diagnostic-capture="project-navigation"
          tabIndex={-1}
        >
          <nav className="rail-nav" aria-label="Project views">
            <button
              type="button"
              className={railMode === 'files' ? 'active' : ''}
              aria-current={railMode === 'files' ? 'page' : undefined}
              onClick={() => setRailMode('files')}
            >
              Files
            </button>
            {gitEnabled ? (
              <button
                type="button"
                className={railMode === 'git' ? 'active' : ''}
                aria-current={railMode === 'git' ? 'page' : undefined}
                onClick={() => setRailMode('git')}
              >
                Git{changedCount > 0 ? ` ${changedCountLabel}` : ''}
              </button>
            ) : null}
            <BeadsRailTab beads={beads} layout={layout} />
          </nav>
          <div className="rail-content">
            <FileTree
              key={`files:${root.hostId}:${root.path}`}
              root={root}
              refreshVersion={watchVersion}
              searchRefreshVersion={contentVersion}
              ignoredRefreshVersion={ignoredRefreshVersion}
              changedFiles={gitChanges?.workingTree}
              gitChangesLimited={gitChanges?.workingTreeLimited}
              selected={
                terminalPathActivation.revealRequest?.path ?? viewer.activeTab?.path
              }
              revealRequest={terminalPathActivation.revealRequest}
              onOpen={viewer.openFile}
              onPointerActivate={focusVisibleActiveTerminalAfterLayout}
              viewerPathRebind={viewer}
              onWorkspaceContentChanged={session.refreshWorkspaceContent}
              connected={connectionState === 'connected'}
              missing={activeWorkspace?.missing}
              hidden={railMode !== 'files'}
              gitEnabled={gitEnabled}
              watchInterestsLimited={watchInterests.limited}
              onExpandedChange={watchInterests.updateExpandedPath}
            />
            {gitEnabled ? (
              <GitPanel
                key={`git:${root.hostId}:${root.path}`}
                root={root}
                refreshVersion={contentVersion}
                historyRefreshVersion={gitVersion}
                onChanges={setGitChanges}
                onOpenChange={(path, base, untracked) =>
                  viewer.openFile(path, true, untracked ? 'git-untracked' : 'git', base)
                }
                onOpenHistory={(path, revision) =>
                  viewer.openFile(path, true, 'git', 'head', revision)
                }
                onOpenGraph={openGitGraph}
                onOpenArchitectureReview={architecture.open}
                connectionState={connectionState}
                hidden={railMode !== 'git'}
                historyPaused={gitGraphActive}
                hasDirtyViewerTabs={viewer.tabs.some((tab) => tab.dirty)}
                onSwitchBranch={switchGitBranch}
                onFetch={fetchGit}
                onPull={pullGit}
                autoFetchIntervalMs={settings.gitAutoFetchIntervalMs}
              />
            ) : null}
            <BeadsRailPanel beads={beads} session={session} layout={layout} />
          </div>
        </aside>
        <PaneResizer
          orientation="vertical"
          className="tree-resizer"
          label="Resize file tree"
          onDragStart={() => {
            if (treeCollapsed) setTreeCollapsed(false)
          }}
          onDrag={(clientX) => {
            const left = workbenchRef.current?.getBoundingClientRect().left ?? 0
            setTreeWidth(clientX - left)
          }}
          onNudge={(delta) => {
            if (treeCollapsed) {
              if (delta > 0) setTreeCollapsed(false)
              return
            }
            const current =
              workbenchRef.current?.querySelector<HTMLElement>('.tree-panel')
            if (current) setTreeWidth(current.getBoundingClientRect().width + delta)
          }}
          onReset={layout.resetTreeWidth}
          action={
            <button
              type="button"
              className="tree-collapse-toggle"
              data-resizer-action
              aria-label={
                treeCollapsed ? 'Restore file explorer' : 'Collapse file explorer'
              }
              aria-pressed={treeCollapsed}
              title={treeCollapsed ? 'Restore file explorer' : 'Collapse file explorer'}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={() => setTreeCollapsed((collapsed) => !collapsed)}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path
                  d={
                    treeCollapsed
                      ? 'M4 3 8.5 8 4 13M8 3l4.5 5L8 13'
                      : 'M12 3 7.5 8l4.5 5M8 3 3.5 8 8 13'
                  }
                />
              </svg>
            </button>
          }
        />
        <section className="viewer-panel" aria-label="File viewer">
          <div
            className={`viewer-groups${viewer.split ? ' split' : ''}`}
            ref={viewerGroupsRef}
          >
            {renderViewerPane(
              'primary',
              viewer.primaryTabs,
              viewer.primaryActiveTab,
              true,
            )}
            {viewer.split ? (
              <>
                <PaneResizer
                  orientation="vertical"
                  className="viewer-split-resizer"
                  label="Resize split viewers"
                  onDrag={(clientX) => {
                    const left =
                      viewerGroupsRef.current?.getBoundingClientRect().left ?? 0
                    setViewerPrimaryWidth(clientX - left)
                  }}
                  onNudge={(delta) => {
                    const current = viewerGroupsRef.current?.querySelector<HTMLElement>(
                      '.viewer-group-primary',
                    )
                    if (current) {
                      setViewerPrimaryWidth(current.getBoundingClientRect().width + delta)
                    }
                  }}
                  onReset={resetViewerPrimaryWidth}
                />
                {renderViewerPane(
                  'secondary',
                  viewer.secondaryTabs,
                  viewer.secondaryActiveTab,
                  false,
                )}
              </>
            ) : null}
          </div>
        </section>
        <PaneResizer
          orientation="horizontal"
          className="terminal-resizer"
          label="Resize terminal"
          onDragStart={() => {
            if (terminalMode !== 'restored') setTerminalMode('restored')
          }}
          onDrag={(clientY) => {
            const bottom = workbenchRef.current?.getBoundingClientRect().bottom ?? 0
            setTerminalHeight(bottom - clientY)
          }}
          onNudge={(delta) => {
            if (terminalMode !== 'restored') {
              if (
                (terminalMode === 'maximized' && delta < 0) ||
                (terminalMode === 'collapsed' && delta > 0)
              ) {
                setTerminalMode('restored')
              }
              return
            }
            const current =
              workbenchRef.current?.querySelector<HTMLElement>('.terminal-panel')
            if (current) setTerminalHeight(current.getBoundingClientRect().height + delta)
          }}
          onReset={layout.resetTerminalHeight}
          action={<TerminalLayoutControls mode={terminalMode} onMode={setTerminalMode} />}
        />
        <TerminalWorkspaceCollection
          state={projectState}
          runtime={terminalWorkspaces}
          terminalPresented={
            destination === 'workspace' &&
            terminalMode !== 'collapsed' &&
            !(web.focused && web.active)
          }
          railCompact={layout.terminalRailCompact}
          onRailCompact={layout.setTerminalRailCompact}
          attachRequestFor={terminalCommands.attachRequestFor}
          onAttachAvailability={terminalCommands.reportLaunchAvailability}
          onRollup={terminalAttention.updateRollup}
          onOpenPath={terminalPathActivation.activate}
          onOpenWebLink={web.openLink}
          preferences={terminalPreferences(settings)}
          onOpenSettings={() => overlays.openSettings()}
          onOpenTerminalSettings={() => overlays.openSettings('terminal')}
          onOpenHarnessSettings={() => overlays.openSettings('harnesses')}
          onAddHarness={overlays.openAddHarnessSettings}
        />
      </main>
      <SessionsApplicationDestination
        active={destination === 'sessions'}
        runtime={terminalWorkspaces}
        onOpened={(state) => (showTerminal(), accept(state), setDestination('workspace'))}
        onError={session.reportError}
        onAttachExternal={terminalCommands.requestExternalAttach}
      />
      {overlays.projectPickerOpen ? (
        <SessionDialog
          hosts={session.hosts}
          currentRoot={root}
          suspended={session.prompts.length > 0}
          onCancel={overlays.closeProjectPicker}
          onConnect={session.connectHost}
          onBrowse={session.browseHost}
          folderPicker={session.folderPicker}
          onDisconnect={session.disconnectHost}
          onOpen={session.openHost}
          onOpened={() => (setDestination('workspace'), overlays.closeProjectPicker())}
        />
      ) : null}
      {overlays.settingsOpen ? (
        <SettingsDialog
          theme={theme}
          settings={settings}
          workspaceRoot={root}
          projectRoot={session.activeProject?.registeredRoot}
          initialDestination={overlays.settingsDestination}
          onClose={overlays.closeSettings}
          onSave={(nextTheme, nextSettings) => {
            setAppTheme(nextTheme)
            setAppSettings(nextSettings)
            overlays.closeSettings()
          }}
        />
      ) : null}
      {session.prompts[0] ? (
        <SshPromptDialog
          key={session.prompts[0].id}
          prompt={session.prompts[0]}
          onAnswer={session.answerPrompt}
        />
      ) : null}
    </div>
  )
}
