import {
  asHarnessProviderId,
  containsHostPath,
  isHarnessProviderId,
  sessionsProjectionDisplayTitle,
  type HarnessProviderId,
  type HostPath,
  type SessionsContextFact,
  type SessionsFact,
  type SessionsObservedSession,
  type SessionsOrigin,
  type SessionsProviderProjection,
  type SessionsTelemetryFacts,
  type SessionsWorkspaceProjection,
} from '../../shared'
import type { CitySessionFact, HostCitySessions } from '../gascity/gascity-city-sessions'
import type { SessionsProjectionIdentityScope } from './sessions-projection-identities'
import { sessionsProjectionPercent } from './sessions-projection-values'

/**
 * Gas City sessions as rows in the global view.
 *
 * Two things happen here and nothing else. Every session is *placed* — matched
 * to a workspace hvir already knows about, because hvir's grouping is hvir's to
 * decide and gc has no opinion about it — and every fact gc reports is carried
 * across verbatim, with everything gc does not report marked unsupported rather
 * than guessed at. The session's own identifier stays in this process: the row
 * carries an opaque handle minted for it.
 *
 * Nothing here is allowed to make hvir *do* anything. A projected row is a
 * description of work someone else started, so it never opens a terminal,
 * connects a host, or starts an observer.
 */

export const SESSIONS_GAS_CITY_ORIGIN: SessionsOrigin = {
  kind: 'external-agent',
  sourceId: 'gas-city',
  sourceName: 'Gas City',
}

/**
 * The provider a projected row carries when gc's harness is not one hvir has
 * registered. It is hvir's own identifier for the source, not gc's for the
 * harness: no foreign name reaches the renderer.
 */
export const SESSIONS_GAS_CITY_PROVIDER: SessionsProviderProjection = {
  id: asHarnessProviderId('gas-city'),
  displayName: 'Gas City agent',
  telemetrySupported: false,
  usageSupported: false,
  sessionKind: 'agent',
}

/** A workspace hvir has discovered, with the project it belongs to. */
export interface SessionsCityWorkspaceTarget {
  readonly root: HostPath
  readonly projectRoot: HostPath
  readonly workspace: SessionsWorkspaceProjection
}

export interface SessionsCityProjectionInput {
  readonly cities: readonly HostCitySessions[]
  readonly workspaces: readonly SessionsCityWorkspaceTarget[]
  readonly identities: SessionsProjectionIdentityScope
  /** Providers hvir has registered, so a known harness keeps its own identity. */
  readonly providers: ReadonlyMap<HarnessProviderId, SessionsProviderProjection>
  /** How many rows are still available in the projection. */
  readonly capacity: number
}

export interface SessionsCityProjection {
  readonly sessions: readonly SessionsObservedSession[]
  /** Present when at least one row needed the source's own provider identity. */
  readonly provider?: SessionsProviderProjection
}

export function projectCitySessions({
  cities,
  workspaces,
  identities,
  providers,
  capacity,
}: SessionsCityProjectionInput): SessionsCityProjection {
  const sessions: SessionsObservedSession[] = []
  let sourceProviderUsed = false
  for (const city of cities) {
    const placement = workspaces.filter(
      (target) => target.root.hostId === city.root.hostId,
    )
    if (placement.length === 0) continue
    for (const fact of city.sessions) {
      if (sessions.length >= capacity) break
      const workspace = placeSession(fact, placement)
      if (workspace === undefined) continue
      const handle = identities.externalSession({
        sourceId: 'gas-city',
        key: fact.sessionKey,
      })
      // Out of handles for this demand: drop the session rather than present
      // one whose identifier hvir cannot keep to itself.
      if (handle === undefined) continue
      const declared = declaredProvider(fact, providers)
      if (declared === undefined) sourceProviderUsed = true
      sessions.push({
        handle,
        workspaceId: workspace.workspaceId,
        origin: SESSIONS_GAS_CITY_ORIGIN,
        providerId: declared?.id ?? SESSIONS_GAS_CITY_PROVIDER.id,
        // A profile is a launch hvir made; there is none behind a session
        // someone else started.
        profile: { status: 'unsupported' },
        title: sessionsProjectionDisplayTitle(
          fact.label,
          handle,
          `${declared?.displayName ?? SESSIONS_GAS_CITY_PROVIDER.displayName} · ${workspace.workspaceName}`,
          [fact.sessionKey, fact.workDir?.path ?? '', fact.rigRoot?.path ?? ''],
        ),
        // `live` here means the session is running, which is the one thing gc
        // does say. It never implies hvir holds a terminal for it: no row
        // without a live PTY qualifier can be opened or attached, whatever its
        // lifecycle reads.
        lifecycle: fact.activity === 'active' ? 'live' : 'retained',
        telemetry: telemetryFor(fact, city),
      })
    }
  }
  return {
    sessions,
    ...(sourceProviderUsed ? { provider: SESSIONS_GAS_CITY_PROVIDER } : {}),
  }
}

/**
 * Where a session belongs, strongest signal first: the workspace its working
 * directory is inside, then the main workspace of the project owning its rig,
 * then the main workspace of the project containing its working directory. A
 * session hvir can place in none of those belongs to work hvir does not track,
 * and showing it under an unrelated project would be worse than not showing it.
 */
function placeSession(
  fact: CitySessionFact,
  targets: readonly SessionsCityWorkspaceTarget[],
): SessionsWorkspaceProjection | undefined {
  const exact = deepest(targets, (target) => target.root, fact.workDir)
  if (exact !== undefined) return exact.workspace
  return mainWorkspace(targets, fact.rigRoot) ?? mainWorkspace(targets, fact.workDir)
}

function mainWorkspace(
  targets: readonly SessionsCityWorkspaceTarget[],
  path: HostPath | undefined,
): SessionsWorkspaceProjection | undefined {
  const owner = deepest(targets, (target) => target.projectRoot, path)
  if (owner === undefined) return undefined
  const main = targets.find(
    (target) =>
      target.workspace.projectId === owner.workspace.projectId && target.workspace.main,
  )
  return main?.workspace ?? owner.workspace
}

/** The innermost containing target, so a worktree beats the project holding it. */
function deepest(
  targets: readonly SessionsCityWorkspaceTarget[],
  rootOf: (target: SessionsCityWorkspaceTarget) => HostPath,
  path: HostPath | undefined,
): SessionsCityWorkspaceTarget | undefined {
  if (path === undefined) return undefined
  let best: SessionsCityWorkspaceTarget | undefined
  for (const target of targets) {
    const root = rootOf(target)
    if (!containsHostPath(root, path)) continue
    if (best === undefined || root.path.length > rootOf(best).path.length) best = target
  }
  return best
}

/**
 * gc's harness, but only when hvir has a provider registered under that name.
 * An unregistered harness gets the source's own provider identity: hvir can say
 * an agent is running without pretending to know the harness behind it.
 */
function declaredProvider(
  fact: CitySessionFact,
  providers: ReadonlyMap<HarnessProviderId, SessionsProviderProjection>,
): SessionsProviderProjection | undefined {
  if (fact.provider === undefined || !isHarnessProviderId(fact.provider)) return undefined
  return providers.get(fact.provider)
}

/**
 * What gc knows, and only that. There is no telemetry channel behind a
 * projected session: the model is never reported, the turn state is not
 * something gc tracks, and context arrives as a percentage with no token count
 * behind it.
 */
function telemetryFor(
  fact: CitySessionFact,
  city: HostCitySessions,
): SessionsTelemetryFacts {
  const observedAt = city.observedAt
  return {
    model: { status: 'unsupported' },
    context: contextFact(fact, city),
    turn: { status: 'unsupported' },
    freshness: city.stale
      ? {
          status: 'stale',
          value: { staleAfterMs: city.staleAfterMs },
          observedAt,
          reason: 'source-unavailable',
        }
      : { status: 'available', value: { staleAfterMs: city.staleAfterMs }, observedAt },
  }
}

function contextFact(
  fact: CitySessionFact,
  city: HostCitySessions,
): SessionsFact<SessionsContextFact> {
  const usedPercent = sessionsProjectionPercent(fact.contextPercent)
  if (usedPercent === undefined) return { status: 'unsupported' }
  return city.stale
    ? {
        status: 'stale',
        value: { usedPercent },
        observedAt: city.observedAt,
        reason: 'source-unavailable',
      }
    : { status: 'available', value: { usedPercent }, observedAt: city.observedAt }
}
