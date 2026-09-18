/**
 * The Companion's composition root on the workbench runtime (ADR-049): the
 * settings owner, the loopback listener that follows it, the Sessions verbs
 * bound as /api rows, and the Away-time Push over the one actionable set.
 *
 * Wind-down runs in the order a phone would notice: Push stops observing,
 * every open page hears `shutdown`, the listener closes, then the settings
 * file is flushed. A revoked pairing closes every page the same way with
 * `revoked`, so no stream outlives the credential that opened it.
 */
import { safeStorage } from 'electron'

import type { CompanionConfigView, HostPath } from '../../shared'
import type { ActionableAttentionSet } from '../attention/actionable-attention-set'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { WorkbenchRuntime } from '../workbench-runtime'
import { AwayPush, type AwayPushOutcome } from './away-push'
import { bindCompanionApi } from './companion-api-routes'
import type { CompanionAssetReader } from './companion-auth'
import {
  CompanionConfigStore,
  type CompanionConfigDiagnostic,
  type CompanionSecretStorage,
  type CompanionStoreFile,
} from './companion-config-store'
import { CompanionListener, type CompanionListenerFailure } from './companion-listener'
import { CompanionServer, type CompanionDiagnostic } from './companion-server'
import {
  CompanionSessionsService,
  type CompanionSessionsPorts,
} from './companion-sessions'
import { CompanionSettings } from './companion-settings'
import {
  createPushDescriber,
  type PushDescribeDiagnostic,
  type PushDescribePorts,
} from './push-describe'
import { companionPushSinkFactory, type NtfyPushSinkOptions } from './push-sink'

export type CompanionOwnerDiagnostic =
  | CompanionConfigDiagnostic
  | CompanionListenerFailure
  | CompanionDiagnostic
  | PushDescribeDiagnostic
  | { readonly kind: 'push-outcome'; readonly outcome: AwayPushOutcome }
  | { readonly kind: 'credential-write-failed'; readonly message: string }

export interface CompanionStoreDependencies {
  readonly host: CompanionStoreFile
  readonly file: HostPath
  /** Defaults to Electron's safeStorage; tests inject a cipher of their own. */
  readonly secrets?: CompanionSecretStorage
}

export interface CompanionDependencies {
  readonly store: CompanionStoreDependencies
  readonly assets: CompanionAssetReader
  readonly sessions: Pick<CompanionSessionsPorts, 'observation' | 'transcripts' | 'sinks'>
  readonly actionable: Pick<ActionableAttentionSet, 'snapshot' | 'observe'>
  /** The PTY supervisor's mirror door (ADR-050); the Companion never spawns or owns. */
  readonly mirrors: Pick<PtySupervisor, 'attachMirror'>
  readonly describe: Omit<PushDescribePorts, 'onDiagnostic'>
  readonly publish: (view: CompanionConfigView) => void
  readonly onDiagnostic?: (diagnostic: CompanionOwnerDiagnostic) => void
  readonly push?: Pick<NtfyPushSinkOptions, 'fetch' | 'timeoutMs'>
  readonly now?: () => number
}

export interface ApplicationCompanion {
  readonly settings: CompanionSettings
  readonly server: CompanionServer
  readonly sessions: CompanionSessionsService
}

export async function installApplicationCompanion(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  deps: CompanionDependencies,
): Promise<ApplicationCompanion> {
  const report = (diagnostic: CompanionOwnerDiagnostic): void =>
    deps.onDiagnostic?.(diagnostic)
  const settings = await loadSettings(deps, report)
  const stopPublishing = settings.observe(deps.publish)
  const sessions = new CompanionSessionsService({
    ...deps.sessions,
    actionable: deps.actionable,
    mirrors: {
      attach: (id, instanceId, handlers) =>
        deps.mirrors.attachMirror(id, instanceId, handlers),
      typingAllowed: () => settings.typingAllowed(),
    },
  })
  const server = new CompanionServer({
    auth: settings.auth,
    assets: deps.assets,
    onDiagnostic: report,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })
  bindCompanionApi(server.router, sessions)
  const push = new AwayPush({
    set: deps.actionable,
    sink: companionPushSinkFactory(settings, deps.push ?? {}),
    describe: createPushDescriber({ ...deps.describe, onDiagnostic: report }),
    onOutcome: (outcome) => {
      if (outcome.result.outcome !== 'sent') report({ kind: 'push-outcome', outcome })
    },
  })
  const listener = new CompanionListener({
    server,
    setStatus: (status) => settings.setStatus(status),
    onFailure: report,
  })
  const stopFollowing = settings.observe((view) => {
    void listener.follow({ enabled: view.enabled, port: view.port })
  })
  const stopRevocation = settings.onRevoked(() => sessions.closeAll('revoked'))
  await listener.follow(settings.view())

  const companion: ApplicationCompanion = { settings, server, sessions }
  return runtime.own('Companion', companion, async () => {
    await stopFollowing()
    await stopRevocation()
    push.dispose()
    sessions.closeAll('shutdown')
    await listener.dispose()
    sessions.dispose()
    await stopPublishing()
    await settings.flush()
  })
}

async function loadSettings(
  deps: CompanionDependencies,
  report: (diagnostic: CompanionOwnerDiagnostic) => void,
): Promise<CompanionSettings> {
  const store = await CompanionConfigStore.load(deps.store.host, deps.store.file, {
    secrets: deps.store.secrets ?? safeStorage,
    onDiagnostic: report,
  })
  return new CompanionSettings({
    store,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    onCredentialWriteFailed: (error) =>
      report({
        kind: 'credential-write-failed',
        message: error instanceof Error ? error.message : String(error),
      }),
  })
}
