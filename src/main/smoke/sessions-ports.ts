/**
 * The Sessions ports for the smoke build, composed the way production composes
 * them: observation over the smoke session store and the live PTY supervisor,
 * usage over the smoke providers, transcripts over a supervisor that reports
 * itself disabled, and the one companion sink registry. Renderer leases
 * deliver to the smoke window; companion leases deliver to the registry.
 */
import type { BrowserWindow } from 'electron'

import type { IpcEventChannel, IpcEventPayload, ProjectHostOption } from '../../shared'
import type { HarnessProviderRegistry } from '../harness/harness-provider'
import { HarnessUsageDemandController } from '../harness/harness-usage-demand-controller'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { sendRendererEvent } from '../renderer-event-delivery'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { SessionsAttachTicketRegistry } from '../sessions/sessions-attach-tickets'
import { SessionsCompanionSinkRegistry } from '../sessions/sessions-companion-sinks'
import {
  dispatchDemandOwner,
  rendererOwnerOf,
  type SessionsCompanionDemandOwner,
  type SessionsDemandOwner,
} from '../sessions/sessions-demand-owner'
import { SessionsObservationPort } from '../sessions/sessions-observation-port'
import { SessionsTranscriptPort } from '../sessions/sessions-transcript-port'
import { SessionsUsageObservationPort } from '../sessions/sessions-usage-observation-port'
import type { TerminalSessionObservationSource } from '../terminal/session-registry'
import type { SmokeCleanup } from './cleanup'
import type { createRemoteProjectFileSmokeHost } from './project-file-operations'
import type { createSmokeProjectState } from './project-state-fixture'

export interface SmokeSessionsPortsOptions {
  readonly host: Pick<ProjectHost, 'hostId' | 'connectionState' | 'watchTier'>
  readonly remoteHost: ReturnType<typeof createRemoteProjectFileSmokeHost>
  readonly projectFixture: Pick<
    ReturnType<typeof createSmokeProjectState>,
    'get' | 'observe'
  >
  readonly providers: HarnessProviderRegistry
  readonly sessions: TerminalSessionObservationSource
  readonly ptys: PtySupervisor
  readonly cleanup: SmokeCleanup
  readonly window: () => BrowserWindow | undefined
  readonly resources: Pick<RendererResourceScopes, 'isCurrent'>
}

export interface SmokeSessionsPorts {
  readonly observation: SessionsObservationPort
  readonly usage: SessionsUsageObservationPort
  readonly transcripts: SessionsTranscriptPort
  readonly attachTickets: SessionsAttachTicketRegistry
  readonly companionSinks: SessionsCompanionSinkRegistry
  readonly hostOptions: () => readonly ProjectHostOption[]
  /** Companion channels that arrived with no sink registered, in order. */
  readonly missingCompanionSinks: readonly string[]
}

export function createSmokeSessionsPorts(
  options: SmokeSessionsPortsOptions,
): SmokeSessionsPorts {
  const { host, remoteHost, cleanup } = options
  const missingCompanionSinks: string[] = []
  const companionSinks = new SessionsCompanionSinkRegistry((channel) => {
    missingCompanionSinks.push(channel)
  })
  const toRenderer = <C extends IpcEventChannel>(
    owner: SessionsDemandOwner,
    channel: C,
    payload: IpcEventPayload<C>,
    companion: (owner: SessionsCompanionDemandOwner) => void,
  ): void =>
    dispatchDemandOwner(owner, {
      renderer: (lease) => {
        const renderer = rendererOwnerOf(lease)
        const window = options.window()
        if (window?.webContents.id !== renderer.id) return
        if (!options.resources.isCurrent(renderer)) return
        sendRendererEvent(window.webContents, channel, payload)
      },
      companion,
    })
  const hostOptions = (): readonly ProjectHostOption[] => [
    {
      hostId: host.hostId,
      label: 'Local',
      kind: 'local' as const,
      connectionState: host.connectionState,
      watchTier: host.watchTier,
    },
    {
      hostId: remoteHost.hostId,
      label: 'Smoke SSH',
      kind: 'ssh' as const,
      connectionState: remoteHost.connectionState,
      watchTier: remoteHost.watchTier,
    },
  ]
  const observation = new SessionsObservationPort({
    projectState: () => options.projectFixture.get(),
    hosts: hostOptions,
    providers: () =>
      options.providers.all().map((provider) => ({
        id: provider.manifest.id,
        displayName: provider.manifest.displayName,
        telemetrySupported: Boolean(provider.telemetry),
        usageSupported: Boolean(provider.usageTelemetry),
        sessionKind: provider.manifest.sessionKind,
      })),
    sessions: options.sessions,
    ptys: options.ptys,
    observeProjects: options.projectFixture.observe,
    emit: (owner, change) =>
      toRenderer(owner, 'sessions:changed', change, (companion) =>
        companionSinks.projection(companion, change),
      ),
  })
  cleanup.defer('Sessions observation', () => observation.dispose())
  const usageDemand = new HarnessUsageDemandController(options.providers)
  cleanup.defer('Sessions usage demand', () => usageDemand.dispose())
  const usage = new SessionsUsageObservationPort({
    sessions: observation,
    ptys: options.ptys,
    usage: usageDemand,
    emit: (owner, change) =>
      toRenderer(owner, 'sessions:usage-changed', change, (companion) =>
        companionSinks.usage(companion, change),
      ),
  })
  cleanup.defer('Sessions usage observation', () => usage.dispose())
  const transcripts = new SessionsTranscriptPort({
    sessions: observation,
    // The smoke build runs no supervisor, so a detail reports that rather
    // than presenting an empty transcript as if it were the session's.
    supervisor: {
      address: () => Promise.resolve({ ok: false, failure: { reason: 'disabled' } }),
    },
    emit: (owner, change) =>
      toRenderer(owner, 'sessions:transcript-changed', change, (companion) =>
        companionSinks.transcript(companion, change),
      ),
  })
  cleanup.defer('Sessions transcript observation', () => transcripts.dispose())
  const attachTickets = new SessionsAttachTicketRegistry()
  cleanup.defer('Sessions attach tickets', () => {
    attachTickets.clear()
  })
  return {
    observation,
    usage,
    transcripts,
    attachTickets,
    companionSinks,
    hostOptions,
    missingCompanionSinks,
  }
}
