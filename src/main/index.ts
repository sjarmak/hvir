import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { registerIpcHandlers } from './ipc'
import { createProjectCommands } from './ipc/project-commands'
import { GitMutationCoordinator } from './git/mutation-coordinator'
import { GitMutationAuthorization } from './git/mutation-authorization'
import { GitWorkerHostRouter } from './git/worker-host-router'
import { gitDiscoveryWorker, gitMutationWorker } from './git/worker-ports'
import { HtmlPreviewProtocol } from './html-preview-protocol'
import { createWorkerClient, workerPath, type WorkerClient } from './worker-host'
import { electronTrash, ProjectHostCatalog, RendererSshPrompter } from './project-host'
import { ProjectFolderPickerCoordinator as FolderPicker } from './project-folder-picker'
import { electronReveal } from './project-host/electron-project-reveal'
import { ProjectRegistry } from './project-registry'
import { ProjectCoordinator } from './project-coordinator'
import { PtySupervisor } from './pty/pty-supervisor'
import { installApplicationAttention } from './attention/attention-owner'
import { ownBeadsService } from './beads/beads-owner'
import { createCompanionAssetReader } from './companion/companion-assets'
import { installApplicationCompanion } from './companion/companion-owner'
import { ownGasCityRuntime, ownGasCityService } from './gascity/gascity-owner'
import { HarnessProfileStore } from './harness/harness-profile-store'
import { HarnessProbeManager } from './harness/harness-probe'
import { harnessProviders } from './harness/harness-provider'
import { createElectronRemoteImagePasteCoordinator } from './harness/electron-clipboard-image'
import { ProjectWatchController } from './project-watch'
import { WorkspaceCoordinator } from './workspace-coordinator'
import { createWorkspaceCleanup } from './workspace-cleanup'
import { WorkspaceRemovalCoordinator } from './workspace-removal-coordinator'
import { TerminalSessionRegistry } from './terminal/session-registry'
import { TerminalWorkspaceMoveCoordinator } from './terminal/terminal-workspace-move-coordinator'
import { installMirrorInputNotice } from './terminal/mirror-input-notice'
import { installTerminalIdentityPublication } from './terminal/terminal-identity-publication'
import { RendererResourceScopes, type RendererOwner } from './renderer-resource-scopes'
import { createRendererPresentationInstaller } from './renderer-presentation-resources'
import { createElectronWindowManager } from './window/electron-window-manager'
import { WorkbenchRuntime } from './workbench-runtime'
import { RuntimeDiagnostics } from './diagnostics/runtime-diagnostics'
import { createDiagnosticReportCoordinator } from './diagnostics/diagnostic-report-coordinator'
import { RendererEventPublisher } from './renderer-event-publisher'
import { createFilenameSearchCoordinator } from './filename-search'
import { createProjectFileOperationCoordinator } from './project-file-operations'
import type { DocumentReviewRuntime } from './document-review'
import { installApplicationDocumentReviewRuntime } from './document-review/document-review-application'
import { installApplicationSessionsObservation } from './sessions/sessions-observation-application'
import { applicationRuntime, applicationUserDataPath } from './application-runtime'
import { localPath, type EchoWorkerProtocol, type GitWorkerProtocol } from '../shared'
HtmlPreviewProtocol.registerScheme()
/** The built renderer directory: the workbench window and the Companion page. */
const rendererRoot = join(__dirname, '../renderer')
function createWorkbenchEntry(): void {
  const runtime = new WorkbenchRuntime({
    start: startup,
    suspend: suspendWorkbenchSessions,
    reopen: reopenWorkbench,
    shutdown,
  })
  const htmlPreviews = runtime.own(
    'HTML preview protocol',
    new HtmlPreviewProtocol(),
    (previews) => previews.dispose(),
  )
  const harnessProbeManager = runtime.own(
    'harness probe manager',
    new HarnessProbeManager(),
    (probes) => probes.dispose(),
  )
  const rendererScopes = runtime.own(
    'renderer resource scopes',
    new RendererResourceScopes(),
    (scopes) => scopes.dispose(),
  )
  const rendererEvents = new RendererEventPublisher(rendererScopes)
  const diagnostics = RuntimeDiagnostics.create(
    applicationRuntime.userDataRoot,
    app.isPackaged || __HVIR_SMOKE_BUILD__,
    (state) => rendererEvents.toWindows('workbench-health:state', state),
  )
  const diagnosticReports = runtime.own(
    'Diagnostic reports',
    createDiagnosticReportCoordinator(diagnostics, rendererScopes, applicationRuntime),
    (reports) => reports.dispose(),
  )
  const diagnosticIpc = { reports: diagnosticReports, evidence: diagnostics }
  diagnostics.recordApplication('application-starting')
  const gitMutationAuthorizations = runtime.own(
    'Git mutation authorizations',
    new GitMutationAuthorization(),
    (authorizations) => authorizations.dispose(),
  )
  let echoWorker: WorkerClient<EchoWorkerProtocol> | null = null
  let gitWorker: WorkerClient<GitWorkerProtocol> | null = null
  let projectRegistry: ProjectRegistry | null = null
  let sshPrompter: RendererSshPrompter | null = null
  let ptySupervisor: PtySupervisor | null = null
  let terminalSessionRegistry: TerminalSessionRegistry | null = null
  let harnessProfileStore: HarnessProfileStore | null = null
  let documentReview: DocumentReviewRuntime | null = null
  let attention: ReturnType<typeof installApplicationAttention> | null = null
  let workspaceCoordinator: WorkspaceCoordinator | null = null
  let hostCatalog: ProjectHostCatalog | null = null
  const installRendererPresentation = createRendererPresentationInstaller({
    scopes: rendererScopes,
    reports: diagnosticReports,
    attention: () => attention,
    sshPrompter: () => sshPrompter,
  })
  const windowManager = runtime.own(
    'Electron window manager',
    createElectronWindowManager({
      htmlPreviews,
      activateRenderer: (ownerId) =>
        installRendererPresentation(rendererScopes.activateOwner(ownerId)),
      rolloverRenderer: (owner) => {
        diagnostics.revokeRenderer(owner)
        const transition = rendererScopes.rolloverOwner(owner.id)
        void transition.cleanup.catch((error) =>
          console.error('[renderer] generation cleanup failed', error),
        )
        return installRendererPresentation(transition.owner)
      },
      revokeRenderer: (owner) => {
        diagnostics.closeRenderer(owner)
        void rendererScopes
          .revokeOwner(owner.id)
          .catch((error) => console.error('[renderer] owner cleanup failed', error))
      },
      isRendererCurrent: (owner) => rendererScopes.isCurrent(owner),
      resumeRendererIpc: (owner) => rendererScopes.resumeOwnerIpc(owner),
      setOwnerFocused: (owner, focused) => attention?.setOwnerFocused(owner, focused),
      startRendererDiagnostics: (owner) => diagnostics.startRenderer(owner),
      rendererReady: (owner) => diagnostics.rendererReady(owner),
      recordWindowHealth: (event) => diagnostics.recordWindowHealth(event),
      onLastWindowClosed: () => {
        void runtime
          .suspend()
          .catch((error) =>
            console.error('[session] cleanup after window close failed', error),
          )
      },
      isShuttingDown: () => runtime.isShuttingDown,
    }),
    (manager) => manager.dispose(),
  )
  const { routes: webPaneRoutes, createWindow } = windowManager
  async function startup(): Promise<void> {
    htmlPreviews.register()
    const emit = rendererEvents.toWindows
    sshPrompter = runtime.own(
      'SSH prompter',
      new RendererSshPrompter(
        (owner, prompt) => rendererEvents.toRenderer(owner, 'ssh:prompt', prompt),
        (owner, hostId) =>
          rendererEvents.toRenderer(owner, 'ssh:prompt-cancel', { hostId }),
      ),
      (prompter) => prompter.cancelAll(),
    )
    hostCatalog = runtime.own(
      'project host catalog',
      await ProjectHostCatalog.create({
        prompter: sshPrompter,
        trustFile: localPath(applicationUserDataPath('known-hosts.json')),
        trashItem: electronTrash(shell),
      }),
      (catalog) => catalog.dispose(),
    )
    const requestedProjectRoot = projectRootArgument()
    const registry = await ProjectRegistry.create(
      requestedProjectRoot ? localPath(requestedProjectRoot) : undefined,
      hostCatalog,
      applicationUserDataPath('projects.json'),
      (state) => emit('project:state', state),
      async () => {
        const selection = await dialog.showOpenDialog({
          title: 'Choose a folder for hvir',
          defaultPath: process.cwd(),
          properties: ['openDirectory'],
        })
        return selection.canceled || !selection.filePaths[0]
          ? undefined
          : localPath(selection.filePaths[0])
      },
    )
    if (!registry) return app.quit()
    projectRegistry = runtime.own('project registry', registry, (item) => item.dispose())
    terminalSessionRegistry = runtime.own(
      'terminal session registry',
      await TerminalSessionRegistry.load(
        hostCatalog.local,
        localPath(applicationUserDataPath('terminal-sessions.json')),
        (event) => diagnostics.recordSessionRegistry(event),
      ),
      (sessions) => sessions.flush(),
    )
    harnessProfileStore = runtime.own(
      'harness profile store',
      await HarnessProfileStore.load(
        hostCatalog.local,
        localPath(applicationUserDataPath('harness-profiles.json')),
      ),
      (profiles) => profiles.flush(),
    )
    await harnessProfileStore
      .importLegacyDefaults(terminalSessionRegistry.profileReferences())
      .catch((error) =>
        console.warn('[harness] legacy recovery profile import failed', error),
      )
    echoWorker = runtime.own(
      'echo worker',
      createWorkerClient<EchoWorkerProtocol>(workerPath('echo-worker.js'), 'hvir-echo'),
      (worker) => worker.dispose(),
    )
    const gitHostRouter = new GitWorkerHostRouter({
      authority: projectRegistry,
      authorizations: gitMutationAuthorizations,
    })
    gitWorker = runtime.own(
      'Git worker',
      createWorkerClient<GitWorkerProtocol>(
        workerPath('git-worker.js'),
        'hvir-git',
        (call) => gitHostRouter.route(call),
      ),
      (worker) => worker.dispose(),
    )
    const filenameSearch = runtime.own(
      'filename search',
      createFilenameSearchCoordinator(gitWorker),
      (search) => search.dispose(),
    )
    const projectFiles = runtime.own(
      'project file operations',
      createProjectFileOperationCoordinator(registry, hostCatalog, rendererScopes),
      (operations) => operations.dispose(),
    )
    ptySupervisor = runtime.own(
      'PTY supervisor',
      new PtySupervisor({
        onDiagnostic: (event) => diagnostics.recordPty(event),
        registerSessionIdentity: (terminalId, harnessSessionId) =>
          terminalSessionRegistry!.recordIdentity(terminalId, harnessSessionId),
        cancelSessionIdentityRegistration: (terminalId) =>
          terminalSessionRegistry!.cancelIdentityRegistration(terminalId),
      }),
      (supervisor) => supervisor.disposeAllAndWait(),
    )
    const gasCity = ownGasCityRuntime(
      runtime,
      { projects: projectRegistry, hosts: hostCatalog },
      (snapshot) => rendererEvents.toWindows('gascity:attention-changed', snapshot),
    )
    attention = installApplicationAttention(runtime, {
      gasCityAttention: gasCity.attention,
      setBadgeCount: (count) => app.setBadgeCount(count),
    })
    const sessionsPorts = installApplicationSessionsObservation(
      runtime,
      projectRegistry,
      hostCatalog,
      terminalSessionRegistry,
      ptySupervisor,
      { events: rendererEvents, diagnostics },
      gasCity.supervisor,
      gasCity.sessionsSource,
      gasCity.streams,
    )
    const companion = await installApplicationCompanion(runtime, {
      store: {
        host: hostCatalog.local,
        file: localPath(applicationUserDataPath('companion.json')),
      },
      assets: createCompanionAssetReader(hostCatalog.local, rendererRoot),
      sessions: { ...sessionsPorts, sinks: sessionsPorts.companionSinks },
      actionable: attention.set,
      mirrors: ptySupervisor,
      describe: {
        terminals: terminalSessionRegistry,
        projects: projectRegistry,
        supervisor: gasCity.supervisor,
        external: gasCity.attention,
      },
      publish: (view) => rendererEvents.toWindows('companion:status-changed', view),
      onDiagnostic: (diagnostic) => console.warn('[companion]', diagnostic),
    })
    documentReview = await installApplicationDocumentReviewRuntime(
      runtime,
      hostCatalog.local,
      rendererScopes,
      ptySupervisor,
      terminalSessionRegistry,
      harnessProviders,
      harnessProfileStore,
    )
    const remoteImagePaste = runtime.own(
      'remote image paste coordinator',
      createElectronRemoteImagePasteCoordinator({
        ptys: ptySupervisor,
        resources: rendererScopes,
        getHost: (hostId) => hostCatalog?.hostById(hostId),
      }),
      (coordinator) => coordinator.dispose(),
    )
    const workspaceCleanup = createWorkspaceCleanup({
      ptys: ptySupervisor,
      resources: rendererScopes,
      sessions: terminalSessionRegistry,
      webPanes: webPaneRoutes,
      releaseHtmlPreviews: (root) => htmlPreviews.releaseWorkspace(root),
    })
    const removal = new WorkspaceRemovalCoordinator(projectRegistry, workspaceCleanup)
    workspaceCoordinator = runtime.own(
      'workspace coordinator',
      new WorkspaceCoordinator({
        registry: projectRegistry,
        discovery: gitDiscoveryWorker(gitWorker),
        removal,
        emitWatch: (event) => emit('project:watch', event),
        createWatch: (target, callbacks) => new ProjectWatchController(target, callbacks),
        shouldPoll: () =>
          !runtime.isShuttingDown && BrowserWindow.getAllWindows().length > 0,
        onError: (message, error) => console.error(message, error),
      }),
      (coordinator) => coordinator.dispose(),
    )
    const projects = new ProjectCoordinator({
      registry: projectRegistry,
      hosts: hostCatalog,
      workspaces: workspaceCoordinator,
      cleanup: workspaceCleanup,
      removal,
      onError: (message, error) => console.error(message, error),
      onHostControlDiagnostic: (event) => diagnostics.recordHostControl(event),
    })
    const gitMutations = new GitMutationCoordinator({
      registry: projectRegistry,
      worker: gitMutationWorker(gitWorker),
      workspaces: workspaceCoordinator,
      authorizations: gitMutationAuthorizations,
      removal,
      onError: (message, error) => console.error(message, error),
    })
    const terminalMoves = new TerminalWorkspaceMoveCoordinator({
      projects: projectRegistry,
      workspaces: workspaceCoordinator,
      sessions: terminalSessionRegistry,
      ptys: ptySupervisor,
      resources: rendererScopes,
      webPanes: webPaneRoutes,
      onError: (message, error) => console.error(message, error),
    })
    installTerminalIdentityPublication(runtime, ptySupervisor, rendererEvents)
    installMirrorInputNotice(runtime, ptySupervisor, rendererEvents)
    const withSshPresentation = <T>(owner: RendererOwner, operation: () => T): T => {
      if (!sshPrompter) throw new Error('SSH prompting is unavailable')
      return sshPrompter.runForOwner(owner, operation)
    }
    const projectCommands = createProjectCommands({
      projects,
      workspaces: workspaceCoordinator,
      git: gitMutations,
      withSshPresentation,
    })
    const getProject = () => registry.active
    const beadsService = ownBeadsService(runtime, getProject, emit)
    const gasCityService = ownGasCityService(getProject, gasCity.reader)
    runtime.own(
      'IPC authority router',
      registerIpcHandlers({
        echoWorker,
        gitWorker,
        filenameSearch,
        projectFiles,
        projectFolderPicker: new FolderPicker(hostCatalog, projects, rendererScopes),
        documentReview: documentReview.coordinator,
        documentReviewDelivery: documentReview.delivery,
        getProject: () => registry.active,
        getHost: (hostId) => hostCatalog?.hostById(hostId),
        connectedHosts: () => hostCatalog?.connectedHosts() ?? [],
        getRegisteredWorkspaceRoot: (root) => registry.registeredWorkspaceRoot(root),
        revealLocalEntry: electronReveal(shell),
        getProjectState: () => registry.state(),
        listHosts: () => hostCatalog?.listHosts() ?? [],
        ...projectCommands,
        respondSshPrompt: (owner, id, answers) =>
          sshPrompter?.respond(owner, id, answers),
        rendererResources: rendererScopes,
        rendererReady: (owner, reportedGeneration) =>
          windowManager.rendererReady(owner, reportedGeneration) &&
          sshPrompter?.activateOwner(owner),
        getWorkbenchHealth: () => diagnostics.healthSnapshot(),
        getExternalAttention: () => gasCity.attention.snapshot(),
        acknowledgeWorkbenchHealth: (id) => diagnostics.acknowledgeHealth(id),
        diagnostics: diagnosticIpc,
        recordIpcContractDiagnostic: (event) => diagnostics.recordIpcContract(event),
        recordRenderContainment: (owner, batch) =>
          diagnostics.recordRenderContainment(owner, batch),
        ptySupervisor,
        terminalSessions: terminalSessionRegistry,
        sessionsObservation: sessionsPorts.observation,
        sessionsUsage: sessionsPorts.usage,
        sessionsTranscripts: sessionsPorts.transcripts,
        sessionsAttachTickets: sessionsPorts.attachTickets,
        terminalMoves,
        harnessProfiles: harnessProfileStore,
        harnessProbes: harnessProbeManager,
        remoteImagePaste,
        beads: beadsService,
        gascity: gasCityService,
        companion: companion.settings,
        updateAttention: (owner, set) => attention?.updateAttention(owner, set),
        updateWebPaneBindings: (owner, bindings) =>
          windowManager.updateWebPaneBindings(owner.id, bindings),
        updateWebPaneFullPage: (owner, paneId) =>
          windowManager.updateWebPaneFullPage(owner.id, paneId),
        htmlPreviews,
        webPanes: webPaneRoutes,
        openExternal: (url) => shell.openExternal(url),
        emit,
      }),
      (router) => router.dispose(),
    )
    createWindow() // Paint before background watch and Git discovery touches a slow directory.
    if (projectRegistry.active.host.connectionState === 'connected') {
      void workspaceCoordinator
        .replaceWatch(projectRegistry.active)
        .then(() => workspaceCoordinator?.refresh(projectRegistry!.active.projectId))
        .catch((error) => console.error('[workspace] initial discovery failed', error))
    }
    workspaceCoordinator.startPolling()
  }
  function reopenWorkbench(): void {
    if (!projectRegistry || BrowserWindow.getAllWindows().length > 0) return
    if (projectRegistry.active.host.connectionState === 'connected') {
      void workspaceCoordinator
        ?.replaceWatch(projectRegistry.active)
        .catch((error) => console.error('[workspace] watch reopen failed', error))
    }
    createWindow()
  }
  function projectRootArgument(): string | undefined {
    const fromFlag = process.argv.find((arg) => arg.startsWith('--project-root='))
    return fromFlag?.slice('--project-root='.length) || process.env.HVIR_PROJECT_ROOT
  }
  void app
    .whenReady()
    .then(async () => {
      if (__HVIR_SMOKE_BUILD__ && process.env['HVIR_SMOKE']) {
        const { runElectronSmokeScenario } = await import('./smoke/scenarios')
        const code = await runElectronSmokeScenario({
          scenario: process.env['HVIR_SMOKE_SCENARIO'],
          projectRoot: localPath(projectRootArgument() ?? process.cwd()),
          createWindow,
          harnessProbeManager,
          htmlPreviews,
          rendererResources: rendererScopes,
          diagnostics: diagnosticIpc,
          runtimeDiagnostics: diagnostics,
          webPaneRoutes,
          rendererReady: windowManager.rendererReady,
          updateWebPaneBindings: windowManager.updateWebPaneBindings,
          updateWebPaneFullPage: windowManager.updateWebPaneFullPage,
          openExternal: (url) => shell.openExternal(url),
          rendererRoot,
        })
        app.exit(code)
        return
      }
      await runtime.start()
      diagnostics.recordApplication('application-ready')
    })
    .catch(async (error: unknown) => {
      diagnostics.recordApplication('application-startup-failed')
      await diagnostics.dispose()
      console.error('HVIR_STARTUP_FAIL', error)
      app.exit(1)
    })
  app.on('window-all-closed', () => {
    if (!__HVIR_SMOKE_BUILD__ && process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (__HVIR_SMOKE_BUILD__ && process.env['HVIR_SMOKE']) return
    void runtime.reopen().catch((error) => console.error('[window] reopen failed', error))
  })
  app.on('before-quit', (event) => {
    if (runtime.isShutdown) return
    event.preventDefault()
    if (runtime.isShuttingDown) return
    diagnostics.recordApplication('application-shutdown-starting')
    void runtime
      .shutdown()
      .then(() => diagnostics.recordApplication('application-shutdown-completed'))
      .catch((error) => {
        diagnostics.recordApplication('application-shutdown-failed')
        console.error('[shutdown] workbench cleanup failed', error)
      })
      .finally(async () => {
        await diagnostics.dispose()
        app.quit()
      })
  })
  async function suspendWorkbenchSessions(): Promise<void> {
    await workspaceCoordinator?.stopWatch()
    await workspaceCoordinator?.settle()
    const roots =
      projectRegistry
        ?.state()
        .projects.flatMap((project) =>
          project.workspaces.map((workspace) => workspace.root),
        ) ?? []
    await Promise.all(roots.map((root) => rendererScopes.revokeWorkspace(root)))
    ptySupervisor?.disposeSessions()
    htmlPreviews.clear()
    await webPaneRoutes
      .closeAll()
      .catch((error) => console.error('[web-pane] suspend cleanup failed', error))
    sshPrompter?.cancelAll()
    await terminalSessionRegistry?.flush()
    await harnessProfileStore?.flush()
    await documentReview?.flush()
    await hostCatalog?.disconnectSshHosts()
  }
  async function shutdown(): Promise<void> {
    workspaceCoordinator?.stopPolling()
    await workspaceCoordinator
      ?.stopWatch()
      .catch((error) => console.error('[shutdown] watcher cleanup failed', error))
    await workspaceCoordinator?.settle()
  }
}
createWorkbenchEntry()
