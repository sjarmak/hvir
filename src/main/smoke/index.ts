import { createSmokeAttention } from './attention-smoke'
import { installSmokeCompanion } from './companion-smoke'
import { verifyCompanionScenario } from './companion'
import { createSmokeSessionsPorts } from './sessions-ports'
import { terminalScenarioTable } from './terminal-scenario-table'
import type { ElectronSmokeDependencies } from './bootstrap-contract'
import { SmokeRendererReadiness } from './renderer-readiness-observer'
import { verifyTerminalLifecycleScenario } from './terminal-lifecycle-scenario'
import { verifyCapacityScenario } from './capacity-scenario'
import { createProjectFixtureCommands } from './project-fixture-commands'
import { verifyNativeHostWorker } from './native-host-worker'
import { verifyRendererReadiness } from './renderer-readiness'
import { createProjectFileFixture } from './project-file-fixture'
import {
  createDocumentReviewFixture,
  documentReviewSmokeProvider,
} from './document-review-fixture'
import { createViewerFixtures } from './viewer-fixtures'
import { createSmokeProjectState } from './project-state-fixture'
import { createSessionsProjectState } from './sessions-project-fixture'
import type { BrowserWindow } from 'electron'
import { dispatchWorkerHostCall } from '../git/worker-host-broker'
import { createFilenameSearchCoordinator } from '../filename-search'
import { createProjectFileOperationCoordinator } from '../project-file-operations'
import { ProjectFolderPickerCoordinator } from '../project-folder-picker'
import { createDocumentReviewRuntime } from '../document-review'
import { BeadsService } from '../beads/beads-service'
import { GasCityService } from '../gascity/gascity-service'
import { HarnessProfileStore } from '../harness/harness-profile-store'
import {
  HarnessProviderRegistry,
  harnessProviderCatalog,
  harnessProviders,
} from '../harness/harness-provider'
import { sendRendererEvent } from '../renderer-event-delivery'
import { registerIpcHandlers } from '../ipc'
import { PtySupervisor } from '../pty/pty-supervisor'
import { createWorkerClient, workerPath } from '../worker-host'
import { createWorkspaceCleanup } from '../workspace-cleanup'
import { SmokeCleanup } from './cleanup'
import { smokeOwnedResourceEvidence } from './owned-resource-evidence'
import {
  reportSmokeFailureEvidence,
  smokeCleanupResource,
  type SmokeFailureCheckpoint,
  type SmokeFailurePhase,
} from './failure-evidence.mts'
import { recordRendererIsolationSelection } from './renderer-isolation'
import { createSmokeImagePasteFallback } from './image-paste-fallback'
import { verifyDiagnosticRestart } from './diagnostic-report-restart'
import { verifyDevelopmentPerformanceMode } from './development-performance'
import { verifyDocumentReviewWorkflow } from './document-review'
import { verifyGitWorkflow } from './git-workflow'
import { verifyPlatformContracts } from './platform-contracts'
import { verifyRendererAuthorityLifecycle } from './renderer-authority'
import { createExternalMoveSmokeControl } from './external-file-move'
import {
  createRemoteProjectFileSmokeHost,
  verifyProjectFileOperationsSmoke,
} from './project-file-operations'
import { verifyFocusedViewer } from './viewer-position'
import { verifyViewerContent } from './viewer-content'
import { verifyWorkbenchHealthScenario } from './workbench-health-scenario'
import { verifyRendererRecoveryScenario } from './renderer-recovery-scenario'
import { verifySessionsProjectionScenario } from './sessions-projection-scenario'
import { sessionsUsageSmokeProvider } from './sessions-usage-provider'
import { createTerminalMoveSmokeHarness } from './terminal-move'
import { createSmokeTerminalSessionStore } from './terminal-session-store'
import { verifyTerminalPresentationLifecycle } from './terminal-presentation'
import { verifyWebPaneWorkflow } from './web-pane'
import { verifyWorkspaceRemoteWorkflow } from './workspace-remote'
import { workspaceCloseSmokeCommands } from './workspace-close'
import {
  asHostId,
  EMPTY_EXTERNAL_ATTENTION,
  hostPath,
  joinHostPath,
  localPath,
  type Disposer,
  type EchoWorkerProtocol,
  type GitWorkerProtocol,
  type IpcEventChannel,
  type IpcEventPayload,
  type WorkbenchHealthSnapshot,
} from '../../shared'

/** Production-composed Electron acceptance workflow selected by `HVIR_SMOKE=1`. */
export async function runSmoke(dependencies: ElectronSmokeDependencies): Promise<number> {
  const {
    createWindow,
    harnessProbeManager,
    htmlPreviews,
    rendererResources,
    mode,
    projectRoot,
    openExternal,
    updateWebPaneBindings,
    updateWebPaneFullPage,
    webPaneRoutes,
    interruptionCheckpoint,
    rendererRoot,
  } = dependencies
  let smokeWindow: BrowserWindow | undefined
  let smokeSupervisor: PtySupervisor | undefined
  let cleanupFailureResource: ReturnType<typeof smokeCleanupResource> = null
  let discardedRendererGenerations = 0
  let stopSmokeWatch: Disposer | undefined
  const cleanup = new SmokeCleanup((name) => interruptionCheckpoint.disposed(name), {
    onFailure: (name) => {
      cleanupFailureResource = smokeCleanupResource(name)
      reportSmokeFailureEvidence(
        'cleanup',
        smokeOwnedResourceEvidence(
          smokeWindow,
          smokeSupervisor,
          stopSmokeWatch !== undefined,
          rendererResources,
        ),
        null,
        cleanupFailureResource,
      )
    },
  })
  let scenarioFailed = false
  let failurePhase: SmokeFailurePhase = 'resources-created'
  let failureCheckpoint: SmokeFailureCheckpoint | null = null
  const recordSmokePhase = (phase: SmokeFailurePhase): void => {
    failurePhase = phase
    failureCheckpoint = null
    reportSmokeFailureEvidence(
      phase,
      smokeOwnedResourceEvidence(
        smokeWindow,
        smokeSupervisor,
        stopSmokeWatch !== undefined,
        rendererResources,
      ),
    )
  }
  const recordSmokeCheckpoint = (checkpoint: SmokeFailureCheckpoint): void => {
    failureCheckpoint = checkpoint
    reportSmokeFailureEvidence(
      failurePhase,
      smokeOwnedResourceEvidence(
        smokeWindow,
        smokeSupervisor,
        stopSmokeWatch !== undefined,
        rendererResources,
      ),
      checkpoint,
    )
  }
  recordSmokePhase(failurePhase)
  try {
    const defaultHarnessProviderId = harnessProviderCatalog().find(
      (provider) => provider.default,
    )!.id
    const smokeRoot = projectRoot
    const {
      host,
      smokeTrashRecoveryRoot,
      failTrashFor,
      prepare: prepareProjectFiles,
    } = createProjectFileFixture(smokeRoot, cleanup)
    const worker = cleanup.acquire(
      'echo worker',
      () =>
        createWorkerClient<EchoWorkerProtocol>(
          workerPath('echo-worker.js'),
          'hvir-echo-smoke',
        ),
      (worker) => worker.dispose(),
    )

    const git = cleanup.acquire(
      'Git worker',
      () =>
        createWorkerClient<GitWorkerProtocol>(
          workerPath('git-worker.js'),
          'hvir-git-smoke',
          (call) => dispatchWorkerHostCall(call, { host, root: projectRoot }),
        ),
      (worker) => worker.dispose(),
    )

    const filenameSearch = createFilenameSearchCoordinator(git)
    cleanup.defer('filename search', () => filenameSearch.dispose())
    const externalMoveSmoke = createExternalMoveSmokeControl()
    const supervisor = new PtySupervisor()
    smokeSupervisor = supervisor
    cleanup.defer('supervised terminals', () => supervisor.disposeAllAndWait())
    const smokeCloseableRoot = joinHostPath(smokeRoot, '.hvir-smoke-closed-project')
    const smokeWebSwitchRoot = joinHostPath(smokeRoot, 'docs')
    const harnessProfilesPath = joinHostPath(
      smokeRoot,
      '.hvir-smoke-harness-profiles.json',
    )
    cleanup.defer('harness profile fixture', () =>
      host.exec('rm', ['-f', '--', harnessProfilesPath.path]).then(() => undefined),
    )
    const smokeRemoteRoot = hostPath(asHostId('smoke-remote'), '/srv/hvir')
    const smokeRemoteHost = createRemoteProjectFileSmokeHost({
      localHost: host,
      localRoot: smokeRoot,
      remoteRoot: smokeRemoteRoot,
    })
    const projectFixture = createSmokeProjectState(
      host,
      smokeRoot,
      smokeRemoteRoot,
      smokeWebSwitchRoot,
      mode !== 'platform-contracts' && mode !== 'renderer-recovery',
      mode === 'terminal-presentation' || mode === 'document-review',
    )
    const {
      base: smokeProjectState,
      remotePresentation: smokeRemoteProjectState,
      remoteFiles: smokeRemoteFileProjectState,
      projectReturn: smokeProjectReturnState,
      set: setSmokeProjectState,
    } = projectFixture
    const documentReviewPath = joinHostPath(
      smokeRoot,
      '.hvir-smoke-document-review-drafts.json',
    )
    await host.connect()
    recordSmokePhase('host-connected')
    await host.exec('rm', ['-f', '--', harnessProfilesPath.path])
    const {
      liveReloadPath,
      liveReloadBefore,
      viewerPositionPath,
      largeJsonPath,
      largeTextPath,
    } = await createViewerFixtures(host, smokeRoot, cleanup, {
      positionDocument: mode === 'viewer-position',
      largeJson: mode === 'viewer-content',
      largeText: mode === 'viewer-position' || mode === 'viewer-content',
      oversizedDiff: mode === 'terminal-presentation',
    })
    const {
      documentReviewFixturePath,
      documentReviewFixtureContents,
      documentReviewCaptureAPath,
      documentReviewCaptureBPath,
    } = await createDocumentReviewFixture(
      host,
      smokeRoot,
      cleanup,
      mode === 'document-review',
    )
    if (mode === 'workspace-remote') await prepareProjectFiles()
    const emit: EmitSmokeEvent = (channel, payload) => {
      if (smokeWindow && !smokeWindow.isDestroyed())
        sendRendererEvent(smokeWindow.webContents, channel, payload)
    }
    const smokeTerminalSessionHarness = createSmokeTerminalSessionStore(smokeRoot)
    const smokeTerminalSessions = smokeTerminalSessionHarness.store
    const smokeSessionsProviders = new HarnessProviderRegistry([
      ...harnessProviders.all(),
      sessionsUsageSmokeProvider,
    ])
    const smokeHarnessProfiles = await HarnessProfileStore.load(host, harnessProfilesPath)
    await host.removeFile(documentReviewPath, { ignoreMissing: true })
    cleanup.defer('document review draft', () =>
      host.removeFile(documentReviewPath, { ignoreMissing: true }),
    )
    const documentReview = await createDocumentReviewRuntime(
      host,
      documentReviewPath,
      rendererResources,
      {
        ptys: supervisor,
        sessions: smokeTerminalSessions,
        providers: harnessProviders,
        profiles: smokeHarnessProfiles,
      },
    )
    cleanup.defer('document review', () => documentReview.dispose())
    const sessionsPorts = createSmokeSessionsPorts({
      host,
      remoteHost: smokeRemoteHost,
      projectFixture,
      providers: smokeSessionsProviders,
      sessions: smokeTerminalSessions,
      ptys: supervisor,
      cleanup,
      window: () => smokeWindow,
      resources: rendererResources,
    })
    const {
      observation: sessionsObservation,
      usage: sessionsUsage,
      transcripts: sessionsTranscripts,
      attachTickets: sessionsAttachTickets,
      hostOptions: smokeHostOptions,
    } = sessionsPorts
    const smokeBeads = new BeadsService({
      getProject: () => ({ host, root: smokeRoot }),
      emitChanged: (event) => emit('beads:changed', event),
    })
    cleanup.defer('beads service', () => smokeBeads.dispose())
    const smokeGasCity = new GasCityService({
      getProject: () => ({ host, root: smokeRoot }),
    })
    const smokeAttention = createSmokeAttention()
    cleanup.defer('attention', () => smokeAttention.dispose())
    const smokeCompanion = await installSmokeCompanion({
      host,
      rendererRoot,
      cleanup,
      sessions: sessionsPorts,
      actionable: smokeAttention.set,
      mirrors: supervisor,
      terminals: smokeTerminalSessions,
      projectState: () => projectFixture.get(),
      publish: (view) => emit('companion:status-changed', view),
    })
    const terminalMoveSmoke = createTerminalMoveSmokeHarness({
      sourceState: smokeProjectState,
      targetRoot: smokeWebSwitchRoot,
      supervisor,
      resources: rendererResources,
      webPanes: webPaneRoutes,
      onState: setSmokeProjectState,
    })
    const workspaceCloseCommands = workspaceCloseSmokeCommands({
      host,
      getState: () => projectFixture.get(),
      setState: setSmokeProjectState,
      cleanup: createWorkspaceCleanup({
        ptys: supervisor,
        resources: rendererResources,
        sessions: smokeTerminalSessions,
        webPanes: webPaneRoutes,
        releaseHtmlPreviews: (root) => htmlPreviews.releaseWorkspace(root),
      }),
    })
    const projectFiles = createProjectFileOperationCoordinator(
      { state: () => projectFixture.get() },
      {
        hostById: (hostId) =>
          hostId === smokeRemoteHost.hostId ? smokeRemoteHost : host,
      },
      rendererResources,
      externalMoveSmoke.picker,
    )
    cleanup.defer('project file operations', () => projectFiles.dispose())
    const {
      ports: projectCommands,
      browseHost,
      openedFolderSelections,
      revealedEntries,
    } = createProjectFixtureCommands({
      host,
      smokeRemoteHost,
      smokeRoot,
      smokeRemoteRoot,
      smokeCloseableRoot,
      smokeWebSwitchRoot,
      projectFixture,
      workspaceCloseCommands,
      smokeHostOptions,
      emit,
      preserveSelection: mode === 'sessions-projection',
      projectReturn: mode === 'terminal-presentation' || mode === 'document-review',
    })
    const projectFolderPicker = new ProjectFolderPickerCoordinator(
      {
        hostById: (hostId) =>
          hostId === smokeRemoteHost.hostId ? smokeRemoteHost : host,
      },
      { browseHost },
      rendererResources,
    )
    const readiness = new SmokeRendererReadiness()
    const ipcRouter = registerIpcHandlers({
      echoWorker: worker,
      gitWorker: git,
      filenameSearch,
      projectFiles,
      projectFolderPicker,
      documentReview: documentReview.coordinator,
      documentReviewDelivery: documentReview.delivery,
      ...projectCommands,
      rendererResources,
      rendererReady: (owner, reportedGeneration) => {
        const accepted = dependencies.rendererReady(owner, reportedGeneration)
        if (accepted) readiness.accept(owner)
        return accepted
      },
      getWorkbenchHealth: memoryOnlyHealth,
      // The smoke harness runs no gas city owner, so nothing is waiting.
      getExternalAttention: () => EMPTY_EXTERNAL_ATTENTION,
      acknowledgeWorkbenchHealth: memoryOnlyHealth,
      diagnostics: dependencies.diagnostics,
      recordIpcContractDiagnostic: () => undefined,
      recordRenderContainment: () => undefined,
      ptySupervisor: supervisor,
      terminalSessions: smokeTerminalSessions,
      sessionsObservation,
      sessionsUsage,
      sessionsTranscripts,
      sessionsAttachTickets,
      terminalMoves: terminalMoveSmoke.coordinator,
      harnessProfiles: smokeHarnessProfiles,
      harnessProbes: harnessProbeManager,
      remoteImagePaste: createSmokeImagePasteFallback(supervisor),
      // A scenario must not overwrite the clipboard of the machine running it.
      systemClipboard: { writeText: () => undefined },
      beads: smokeBeads,
      gascity: smokeGasCity,
      updateAttention: smokeAttention.updateAttention,
      companion: smokeCompanion.settings,
      updateWebPaneBindings: (owner, bindings) =>
        updateWebPaneBindings(owner.id, bindings),
      updateWebPaneFullPage: (owner, paneId) => updateWebPaneFullPage(owner.id, paneId),
      htmlPreviews,
      webPanes: webPaneRoutes,
      openExternal,
      emit,
    })
    cleanup.defer('IPC authority router', () => ipcRouter.dispose())
    stopSmokeWatch = host.watch(smokeRoot, (event) => emit('project:watch', event), {
      recursive: true,
      excludeDirectoryNames: ['.git', 'node_modules', 'out', 'dist'],
    })
    cleanup.defer('project watch', async () => {
      await stopSmokeWatch?.()
      stopSmokeWatch = undefined
    })
    recordSmokePhase('watch-active')
    const win = createWindow(() => {
      discardedRendererGenerations++
    })
    smokeWindow = win
    cleanup.defer('smoke window', async () => {
      if (!smokeWindow || smokeWindow.isDestroyed()) return
      const ownerId = smokeWindow.webContents.id
      await webPaneRoutes.closeOwner(ownerId)
      smokeWindow.destroy()
    })
    await new Promise<void>((resolve) => win.once('ready-to-show', resolve))
    const initialRendererGeneration = rendererResources.currentOwner(
      win.webContents.id,
    ).generation
    recordSmokePhase('window-ready')
    console.log('[smoke] window ready-to-show OK')
    await verifyRendererReadiness(win)
    recordSmokePhase('renderer-ready')
    const predecessorSelectionObserved = await recordRendererIsolationSelection(
      win,
      interruptionCheckpoint,
    )
    await interruptionCheckpoint.reach({
      name: 'renderer-watch-ready',
      ownerGeneration: initialRendererGeneration,
      watcherActive: stopSmokeWatch !== undefined,
      predecessorSelectionObserved,
    })
    recordSmokePhase('scenario-active')
    if (await verifyDevelopmentPerformanceMode(win, mode)) return 0
    if (mode === 'renderer-recovery') {
      const result = await verifyRendererRecoveryScenario({
        win,
        resources: rendererResources,
        diagnostics: dependencies.runtimeDiagnostics,
        supervisor,
        routes: webPaneRoutes,
        root: smokeRoot,
        liveReloadPath,
        host,
        readiness,
        discardedGenerations: () => discardedRendererGenerations,
        checkpoint: recordSmokeCheckpoint,
      })
      console.log(`[smoke] renderer recovery OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'sessions-projection') {
      const result = await verifySessionsProjectionScenario({
        win,
        initialOwner: rendererResources.currentOwner(win.webContents.id),
        resources: rendererResources,
        readiness,
        state: createSessionsProjectState(
          host,
          smokeRoot,
          smokeWebSwitchRoot,
          smokeCloseableRoot,
          smokeRemoteRoot,
          smokeProjectState,
        ),
        publishState: (state) => emit('project:state', setSmokeProjectState(state)),
        providerId: defaultHarnessProviderId,
        roots: [smokeWebSwitchRoot, smokeCloseableRoot, smokeRemoteRoot],
        addRetained: smokeTerminalSessionHarness.add,
        supervisor,
        usageHost: host,
        usageProvider: sessionsUsageSmokeProvider,
        captureDirectory: process.env.HVIR_SESSIONS_CAPTURE_DIR
          ? localPath(process.env.HVIR_SESSIONS_CAPTURE_DIR)
          : undefined,
      })
      console.log(`[smoke] Sessions projection OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (await verifyDiagnosticRestart(win, dependencies.runtimeDiagnostics)) return 0
    if (mode === 'platform-contracts') {
      const result = await verifyPlatformContracts({ htmlPreviews, supervisor, win })
      console.log(`[smoke] platform contracts OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'workspace-remote') {
      const projectFilesResult = await verifyProjectFileOperationsSmoke({
        win,
        localHost: host,
        localRoot: smokeRoot,
        remoteRoot: smokeRemoteRoot,
        switchedRoot: smokeWebSwitchRoot,
        trashRecoveryRoot: smokeTrashRecoveryRoot,
        externalMove: externalMoveSmoke,
        failTrashFor,
        localState: smokeProjectState,
        remoteState: smokeRemoteFileProjectState,
        switchedState: () => smokeProjectReturnState('smoke-project-return'),
        publish: (state) => emit('project:state', setSmokeProjectState(state)),
        revealedEntries,
        checkpoint: recordSmokeCheckpoint,
      })
      console.log(`[smoke] project file operations OK (${projectFilesResult})`)
      const result = await verifyWorkspaceRemoteWorkflow({
        win,
        host,
        supervisor,
        resources: rendererResources,
        activeRoot: smokeRoot,
        closeRoot: smokeWebSwitchRoot,
        getState: () => projectFixture.get(),
        setState: setSmokeProjectState,
        emitState: (state) => emit('project:state', state),
        baseState: smokeProjectState,
        remoteState: smokeRemoteProjectState,
        emitHostKeyPrompt: () =>
          emit('ssh:prompt', {
            id: 9001,
            hostId: 'smoke-host',
            kind: 'host-key',
            title: 'Trust smoke-host?',
            instructions: 'Verify the SHA-256 fingerprint before trusting this host.',
            fingerprint: `SHA256:${'abcdefghijklmnopqrstuvwxyz'.repeat(4)}`,
            prompts: [],
          }),
        openedFolderSelections,
        recovery: {
          add: smokeTerminalSessionHarness.add,
          has: smokeTerminalSessionHarness.has,
        },
      })
      console.log(`[smoke] workspace + remote workflow OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'web-pane') {
      const result = await verifyWebPaneWorkflow({
        win,
        supervisor,
        resources: rendererResources,
        routes: webPaneRoutes,
        activeRoot: smokeRoot,
        switchRoot: smokeWebSwitchRoot,
        baseState: smokeProjectState,
        setState: setSmokeProjectState,
        emitState: (state) => emit('project:state', state),
        interruptionCheckpoint,
        predecessorSelectionObserved,
        checkpoint: recordSmokeCheckpoint,
      })
      console.log(`[smoke] web pane workflow OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'renderer-authority') {
      const result = await verifyRendererAuthorityLifecycle({
        win,
        resources: rendererResources,
        checkpoint: recordSmokeCheckpoint,
      })
      console.log(`[smoke] renderer authority lifecycle OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'document-review') {
      const result = await verifyDocumentReviewWorkflow({
        checkpoint: recordSmokeCheckpoint,
        win,
        host,
        root: smokeRoot,
        document: documentReviewFixturePath,
        documentContents: documentReviewFixtureContents,
        captureA: documentReviewCaptureAPath,
        captureB: documentReviewCaptureBPath,
        reviewFile: documentReviewPath,
        review: documentReview,
        profiles: smokeHarnessProfiles,
        provider: documentReviewSmokeProvider(),
        supervisor,
        resources: rendererResources,
      })
      console.log(`[smoke] document review workflow OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'viewer-position') {
      const result = await verifyFocusedViewer(
        win,
        host,
        liveReloadPath,
        viewerPositionPath,
        () =>
          emit('project:watch', {
            type: 'change',
            path: joinHostPath(smokeRoot, '.git/index'),
          }),
        recordSmokeCheckpoint,
      )
      console.log(`[smoke] source/diff viewer positions OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'viewer-content') {
      await verifyViewerContent({
        checkpoint: recordSmokeCheckpoint,
        win,
        projectState: projectFixture,
        supervisor,
        host,
        liveReloadPath,
        largeJsonPath,
        largeTextPath,
        liveReloadBefore,
      })
      return 0
    }
    if (mode === 'git-workflow') {
      const result = await verifyGitWorkflow({
        win,
        host,
        root: smokeRoot,
        untrackedPath: liveReloadPath,
      })
      console.log(`[smoke] Git workflow OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'terminal-presentation') {
      const presentation = await verifyTerminalPresentationLifecycle(
        win,
        supervisor,
        recordSmokeCheckpoint,
        smokeRoot,
      )
      console.log(`[smoke] terminal presentation lifecycle OK (${presentation})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'terminal-lifecycle') {
      await verifyTerminalLifecycleScenario({
        win,
        supervisor,
        resources: rendererResources,
        root: smokeRoot,
        initialGeneration: initialRendererGeneration,
        connectedState: smokeProjectState('connected'),
        disconnectedState: smokeProjectState('disconnected'),
        emitProjectState: (state) => emit('project:state', setSmokeProjectState(state)),
        setRecoverySessions: smokeTerminalSessionHarness.set,
      })
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'capacity') {
      await verifyCapacityScenario(
        win,
        supervisor,
        host,
        liveReloadPath,
        defaultHarnessProviderId,
        smokeTerminalSessionHarness,
      )
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'native-host-worker') {
      await verifyNativeHostWorker(worker, host, smokeRoot)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'companion') {
      const result = await verifyCompanionScenario({
        companion: smokeCompanion,
        bundle: host,
        root: smokeRoot,
        providerId: defaultHarnessProviderId,
        addRetained: smokeTerminalSessionHarness.add,
        sourceListeners: smokeTerminalSessionHarness.listenerCount,
      })
      console.log(`[smoke] companion OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'workbench-health') {
      const result = await verifyWorkbenchHealthScenario(
        win,
        rendererResources,
        dependencies.rendererReady,
      )
      console.log(`[smoke] workbench health fault injection OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    const terminalScenario = terminalScenarioTable({
      win,
      supervisor,
      host,
      smokeRoot,
      harness: terminalMoveSmoke,
      emitState: (state) => emit('project:state', state),
      attention: smokeAttention,
      resources: rendererResources,
    })[mode]
    if (terminalScenario !== undefined) {
      await terminalScenario()
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    throw new Error('Selected smoke scenario has no implementation')
  } catch (err) {
    scenarioFailed = true
    reportSmokeFailureEvidence(
      failurePhase,
      smokeOwnedResourceEvidence(
        smokeWindow,
        smokeSupervisor,
        stopSmokeWatch !== undefined,
        rendererResources,
      ),
      failureCheckpoint,
    )
    console.error('HVIR_SMOKE_FAIL', err)
    return 1
  } finally {
    try {
      await cleanup.run()
    } catch (cleanupError) {
      reportSmokeFailureEvidence(
        'cleanup',
        smokeOwnedResourceEvidence(
          smokeWindow,
          smokeSupervisor,
          stopSmokeWatch !== undefined,
          rendererResources,
        ),
        null,
        cleanupFailureResource,
      )
      console.error('HVIR_SMOKE_CLEANUP_FAIL', cleanupError)
      // A successful scenario must still fail when cleanup does not complete.
      if (!scenarioFailed) {
        // eslint-disable-next-line no-unsafe-finally
        throw cleanupError
      }
    }
  }
}

type EmitSmokeEvent = <E extends IpcEventChannel>(
  channel: E,
  payload: IpcEventPayload<E>,
) => void

/** The smoke build keeps no durable health evidence; a read and an acknowledge both say so. */
function memoryOnlyHealth(): WorkbenchHealthSnapshot {
  return { version: 1, evidence: 'memory-only', items: [], dropped: 0 }
}
