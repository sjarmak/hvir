import type { ExternalAttentionSnapshot, HostPath, ProjectState } from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import type { WorkbenchRuntime } from '../workbench-runtime'
import {
  GasCityAttention,
  type CityAttentionStreams,
  type CityAttentionWorkspaceTarget,
} from './city-attention'
import { GasCityEventStreams, type CityEventStreamHost } from './city-event-streams'
import { GasCityReader, type GasCityTarget } from './gascity-reader'
import { GasCityService } from './gascity-service'
import { GasCitySessionsSource } from './gascity-sessions-source'
import { GascitySupervisorAccess, type SupervisorAccess } from './supervisor-access'
import { gascitySupervisorConnect } from './supervisor-client'

/** What the Gas City owners need to know about hvir's hosts and projects. */
export interface GasCityHostDeps {
  readonly projects: {
    state(): ProjectState
    observe(listener: () => void): Disposer
  }
  readonly hosts: {
    connectedHosts(): readonly ProjectHost[]
    onHostStateChange(listener: () => void): Disposer
  }
}

/**
 * The one reader every Gas City surface reads through. Sharing it is what makes
 * a second surface cost no second `gc` invocation: the crew panel's poll and
 * the global sessions view hit the same cache, and whichever of them is
 * refreshing keeps the other current.
 */
export function ownGasCityReader(): GasCityReader {
  return new GasCityReader()
}

/**
 * Construct the GasCityService. It holds no watches or timers — the crew view
 * polls while visible — so there is nothing to dispose, and the composition
 * root's Gas City footprint stays a single call.
 */
export function ownGasCityService(
  getProject: () => { readonly host: ProjectHost; readonly root: HostPath },
  reader: GasCityReader,
): GasCityService {
  return new GasCityService({ getProject, env: process.env, reader })
}

/**
 * The Gas City source behind the global sessions view.
 *
 * Its candidate roots are the registered project roots on hosts that are
 * already connected. Nothing here connects a host or materializes one: a
 * session hvir did not launch must never be the reason it dials out.
 */
export function ownGasCitySessionsSource(
  reader: GasCityReader,
  deps: GasCityHostDeps,
): GasCitySessionsSource {
  return new GasCitySessionsSource({
    reader,
    candidates: () => {
      const connected = new Map(
        deps.hosts.connectedHosts().map((host) => [host.hostId, host]),
      )
      const targets: GasCityTarget[] = []
      for (const project of deps.projects.state().projects) {
        const host = connected.get(project.registeredRoot.hostId)
        if (host === undefined) continue
        targets.push({ host, root: project.registeredRoot })
      }
      return targets
    },
    observeCandidates: (listener) => {
      const disposers = [
        deps.projects.observe(listener),
        deps.hosts.onHostStateChange(listener),
      ]
      return () => {
        for (const dispose of disposers.reverse()) void dispose()
      }
    },
  })
}

/**
 * The one supervisor access every Gas City consumer speaks through, so a host
 * has a single client and a single city-name cache however many surfaces are
 * reading it.
 *
 * Only a host hvir is already connected to: a session hvir did not launch must
 * never be the reason it dials out (ADR-046).
 */
export function ownGasCitySupervisorAccess(hosts: {
  connectedHosts(): readonly ProjectHost[]
}): GascitySupervisorAccess {
  return new GascitySupervisorAccess({
    connectFor: (hostId) => {
      const host = hosts.connectedHosts().find((candidate) => candidate.hostId === hostId)
      return host === undefined ? undefined : gascitySupervisorConnect(host)
    },
  })
}

/**
 * The per-host city event streams, following open projects.
 *
 * The host set is every host with a registered project open, paired with the
 * city root already known for one of its roots when a read has resolved one.
 * The streams are not scoped to any view: a hidden or closed Sessions list
 * changes nothing about them (ADR-048).
 */
export function ownGasCityEventStreams(
  access: SupervisorAccess,
  reader: GasCityReader,
  deps: GasCityHostDeps,
): GasCityEventStreams {
  const streams = new GasCityEventStreams({
    access,
    hosts: () => {
      const connected = new Set(deps.hosts.connectedHosts().map((host) => host.hostId))
      const hosts = new Map<string, CityEventStreamHost>()
      for (const project of deps.projects.state().projects) {
        const { hostId } = project.registeredRoot
        if (!connected.has(hostId)) continue
        const cityRoot = reader.peekContext(project.registeredRoot)?.cityRoot
        const held = hosts.get(hostId)
        // One stream per host however many of its projects are open; a city root
        // is only an improvement on the entry already there.
        if (held !== undefined && (held.cityRoot !== undefined || cityRoot === undefined))
          continue
        hosts.set(hostId, { hostId, ...(cityRoot === undefined ? {} : { cityRoot }) })
      }
      return [...hosts.values()]
    },
    observeHosts: (listener) => {
      const disposers = [
        deps.projects.observe(listener),
        deps.hosts.onHostStateChange(listener),
      ]
      return () => {
        for (const dispose of disposers.reverse()) void dispose()
      }
    },
  })
  streams.start()
  return streams
}

/**
 * The attention rollup over those streams.
 *
 * Its workspaces are the open, present workspaces of the registered projects,
 * which is what makes a pending interaction land in the same workspace the
 * projected row does. Like the streams, it follows open projects rather than a
 * view: with Sessions closed a blocked worker still raises the project tab and
 * the nav badge (ADR-048).
 */
export function ownGasCityAttention(
  access: SupervisorAccess,
  streams: CityAttentionStreams,
  deps: GasCityHostDeps,
  publish: (snapshot: ExternalAttentionSnapshot) => void,
): GasCityAttention {
  const attention = new GasCityAttention({
    access,
    streams,
    publish,
    workspaces: () => {
      const targets: CityAttentionWorkspaceTarget[] = []
      for (const project of deps.projects.state().projects) {
        for (const workspace of project.workspaces) {
          // A closed or missing workspace owns no runtime and shows no badge,
          // so an interaction placed there would be attention nobody can see.
          if (workspace.closed || workspace.missing) continue
          targets.push({
            workspaceId: workspace.id,
            root: workspace.root,
            projectRoot: project.registeredRoot,
            projectKey: project.id,
            main: workspace.main,
          })
        }
      }
      return targets
    },
    observeWorkspaces: (listener) => deps.projects.observe(listener),
  })
  attention.start()
  return attention
}

/** Every Gas City owner the composition root holds, built once and shared. */
export interface GasCityRuntime {
  readonly reader: GasCityReader
  readonly supervisor: GascitySupervisorAccess
  readonly streams: GasCityEventStreams
  readonly attention: GasCityAttention
  readonly sessionsSource: GasCitySessionsSource
}

/**
 * Own the Gas City surfaces on the workbench runtime: one reader, one
 * supervisor access, the per-host event streams and the attention rollup
 * over them, disposed in reverse. The streams and the rollup follow open
 * projects, not any view: a blocked worker raises attention with the
 * Sessions list closed (ADR-048).
 */
export function ownGasCityRuntime(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  deps: GasCityHostDeps,
  publish: (snapshot: ExternalAttentionSnapshot) => void,
): GasCityRuntime {
  const reader = ownGasCityReader()
  const supervisor = ownGasCitySupervisorAccess(deps.hosts)
  const streams = runtime.own(
    'Gas City event streams',
    ownGasCityEventStreams(supervisor, reader, deps),
    (owned) => owned.dispose(),
  )
  const attention = runtime.own(
    'Gas City attention rollup',
    ownGasCityAttention(supervisor, streams, deps, publish),
    (owned) => owned.dispose(),
  )
  return {
    reader,
    supervisor,
    streams,
    attention,
    sessionsSource: ownGasCitySessionsSource(reader, deps),
  }
}
