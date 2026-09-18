import { harnessProviders } from '../harness/harness-provider'
import { HarnessUsageDemandController } from '../harness/harness-usage-demand-controller'
import type { HostId, ProjectState, ProjectHostOption } from '../../shared'
import type { Disposer } from '../project-host/project-host'
import type {
  PtyObservationSource,
  PtyUsageObservationSource,
} from '../pty/pty-supervisor'
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { TerminalSessionObservationSource } from '../terminal/session-registry'
import type { WorkbenchRuntime } from '../workbench-runtime'
import {
  SessionsObservationPort,
  type CityEventsObservationSource,
  type CitySessionsObservationSource,
} from './sessions-observation-port'
import { SessionsUsageObservationPort } from './sessions-usage-observation-port'
import { SessionsTranscriptPort } from './sessions-transcript-port'
import { SessionsAttachTicketRegistry } from './sessions-attach-tickets'
import { SessionsCompanionSinkRegistry } from './sessions-companion-sinks'
import { dispatchDemandOwner, rendererOwnerOf } from './sessions-demand-owner'
import type { SupervisorAccess } from '../gascity/supervisor-access'

/**
 * What Sessions needs from the host city event streams, and nothing more.
 *
 * Read for the interactions a city declared, and told when hvir answers one so
 * the attention it raised clears on the answer rather than on the next read
 * (ADR-048). Sessions never starts, stops, or resumes a stream: the lifetime
 * belongs to open projects, which is what lets a closed view raise attention.
 */
export interface SessionsCityEventsPort extends CityEventsObservationSource {
  withdrawPending(hostId: HostId, requestId: string): void
}

export interface ApplicationSessionsObservation {
  readonly observation: SessionsObservationPort
  readonly usage: SessionsUsageObservationPort
  readonly transcripts: SessionsTranscriptPort
  readonly attachTickets: SessionsAttachTicketRegistry
  /** Where companion-kind leases are told about changes (ADR-049). */
  readonly companionSinks: SessionsCompanionSinkRegistry
}

/**
 * Where a lease's changes go, by owner kind: renderer leases over IPC, and
 * companion leases to the registered sink. A companion change with no sink
 * is recorded, never thrown.
 */
export interface SessionsChangeDelivery {
  readonly events: Pick<RendererEventPublisher, 'toRenderer'>
  readonly diagnostics: Pick<RuntimeDiagnostics, 'recordSessionsCompanionSinkMissing'>
}

/** Feature-owned application composition for demand-scoped Sessions observation. */
export function installApplicationSessionsObservation(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  projects: { state(): ProjectState; observe(listener: () => void): Disposer },
  hosts: { listHosts(): readonly ProjectHostOption[] },
  sessions: TerminalSessionObservationSource,
  ptys: PtyObservationSource & PtyUsageObservationSource,
  delivery: SessionsChangeDelivery,
  /** The shared Gas City access; one client per host for every consumer. */
  supervisor: SupervisorAccess,
  cities?: CitySessionsObservationSource,
  cityEvents?: SessionsCityEventsPort,
): ApplicationSessionsObservation {
  const { events } = delivery
  const companionSinks = runtime.own(
    'Sessions companion sinks',
    new SessionsCompanionSinkRegistry((channel) =>
      delivery.diagnostics.recordSessionsCompanionSinkMissing(channel),
    ),
    (registry) => registry.clear(),
  )
  const observation = runtime.own(
    'Sessions observation port',
    new SessionsObservationPort({
      projectState: () => projects.state(),
      hosts: () => hosts.listHosts(),
      providers: () =>
        harnessProviders.all().map((provider) => ({
          id: provider.manifest.id,
          displayName: provider.manifest.displayName,
          telemetrySupported: Boolean(provider.telemetry),
          usageSupported: Boolean(provider.usageTelemetry),
          sessionKind: provider.manifest.sessionKind,
          contextPressure: provider.manifest.contextPressure,
        })),
      sessions,
      ptys,
      observeProjects: (listener) => projects.observe(listener),
      emit: (owner, change) =>
        dispatchDemandOwner(owner, {
          renderer: (renderer) =>
            events.toRenderer(rendererOwnerOf(renderer), 'sessions:changed', change),
          companion: (companion) => companionSinks.projection(companion, change),
        }),
      ...(cities === undefined ? {} : { cities }),
      ...(cityEvents === undefined ? {} : { events: cityEvents }),
    }),
    (observation) => observation.dispose(),
  )
  const demand = runtime.own(
    'Harness usage demand controller',
    new HarnessUsageDemandController(harnessProviders),
    (controller) => controller.dispose(),
  )
  const usage = runtime.own(
    'Sessions usage observation port',
    new SessionsUsageObservationPort({
      sessions: observation,
      ptys,
      usage: demand,
      emit: (owner, change) =>
        dispatchDemandOwner(owner, {
          renderer: (renderer) =>
            events.toRenderer(
              rendererOwnerOf(renderer),
              'sessions:usage-changed',
              change,
            ),
          companion: (companion) => companionSinks.usage(companion, change),
        }),
    }),
    (port) => port.dispose(),
  )
  const transcripts = runtime.own(
    'Sessions transcript port',
    new SessionsTranscriptPort({
      sessions: observation,
      supervisor,
      emit: (owner, change) =>
        dispatchDemandOwner(owner, {
          renderer: (renderer) =>
            events.toRenderer(
              rendererOwnerOf(renderer),
              'sessions:transcript-changed',
              change,
            ),
          companion: (companion) => companionSinks.transcript(companion, change),
        }),
      ...(cityEvents === undefined
        ? {}
        : {
            onPendingAnswered: (hostId: HostId, requestId: string) => {
              cityEvents.withdrawPending(hostId, requestId)
            },
          }),
    }),
    (port) => port.dispose(),
  )
  const attachTickets = runtime.own(
    'Sessions attach tickets',
    new SessionsAttachTicketRegistry(),
    (registry) => {
      registry.clear()
    },
  )
  return { observation, usage, transcripts, attachTickets, companionSinks }
}
