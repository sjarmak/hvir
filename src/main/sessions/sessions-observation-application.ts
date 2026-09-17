import { harnessProviders } from '../harness/harness-provider'
import { HarnessUsageDemandController } from '../harness/harness-usage-demand-controller'
import type { ProjectState, ProjectHostOption } from '../../shared'
import type { Disposer } from '../project-host/project-host'
import type {
  PtyObservationSource,
  PtyUsageObservationSource,
} from '../pty/pty-supervisor'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { TerminalSessionObservationSource } from '../terminal/session-registry'
import type { WorkbenchRuntime } from '../workbench-runtime'
import {
  SessionsObservationPort,
  type CitySessionsObservationSource,
} from './sessions-observation-port'
import { SessionsUsageObservationPort } from './sessions-usage-observation-port'
import { SessionsTranscriptPort } from './sessions-transcript-port'
import { SessionsAttachTicketRegistry } from './sessions-attach-tickets'
import { GascitySupervisorAccess } from '../gascity/supervisor-access'
import { gascitySupervisorConnect } from '../gascity/supervisor-client'
import type { ProjectHost } from '../project-host/project-host'

export interface ApplicationSessionsObservation {
  readonly observation: SessionsObservationPort
  readonly usage: SessionsUsageObservationPort
  readonly transcripts: SessionsTranscriptPort
  readonly attachTickets: SessionsAttachTicketRegistry
}

/** Feature-owned application composition for demand-scoped Sessions observation. */
export function installApplicationSessionsObservation(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  projects: { state(): ProjectState; observe(listener: () => void): Disposer },
  hosts: {
    listHosts(): readonly ProjectHostOption[]
    connectedHosts(): readonly ProjectHost[]
  },
  sessions: TerminalSessionObservationSource,
  ptys: PtyObservationSource & PtyUsageObservationSource,
  events: Pick<RendererEventPublisher, 'toRenderer'>,
  cities?: CitySessionsObservationSource,
): ApplicationSessionsObservation {
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
      emit: (owner, change) => events.toRenderer(owner, 'sessions:changed', change),
      ...(cities === undefined ? {} : { cities }),
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
      emit: (owner, change) => events.toRenderer(owner, 'sessions:usage-changed', change),
    }),
    (port) => port.dispose(),
  )
  const supervisor = new GascitySupervisorAccess({
    // Only a host hvir is already connected to. A projected row must never be
    // the reason a connection is opened (ADR-046).
    connectFor: (hostId) => {
      const host = hosts.connectedHosts().find((candidate) => candidate.hostId === hostId)
      return host === undefined ? undefined : gascitySupervisorConnect(host)
    },
  })
  const transcripts = runtime.own(
    'Sessions transcript port',
    new SessionsTranscriptPort({
      sessions: observation,
      supervisor,
      emit: (owner, change) =>
        events.toRenderer(owner, 'sessions:transcript-changed', change),
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
  return { observation, usage, transcripts, attachTickets }
}
