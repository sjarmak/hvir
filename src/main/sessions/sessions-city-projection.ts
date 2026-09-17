import {
  asHarnessProviderId,
  isHarnessProviderId,
  sessionsProjectionDisplayTitle,
  type HarnessProviderId,
  type HostId,
  type HostPath,
  type SessionsAttentionValue,
  type SessionsContextFact,
  type SessionsFact,
  type SessionsObservedSession,
  type SessionsOrigin,
  type SessionsProviderProjection,
  type SessionsTelemetryFacts,
  type SessionsTurnFact,
  type SessionsWorkspaceProjection,
  type ExternalSessionAttachment,
} from '../../shared'
import {
  hostCityEventsFresh,
  type HostCityEvents,
} from '../gascity/city-event-facts'
import {
  placeCitySession,
  type CityPlacementTarget,
} from '../gascity/city-session-placement'
import type { CitySessionFact, HostCitySessions } from '../gascity/gascity-city-sessions'
import { externalSessionDigest } from '../terminal/external-session-attachment'
import type {
  SessionsExternalSessionTarget,
  SessionsProjectionIdentityScope,
} from './sessions-projection-identities'
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

/**
 * A terminal hvir launched to attach to one of these sessions, with the
 * attachment it recorded at spawn. The digest is the whole of the join: no
 * title, path, or timing is consulted (ADR-046).
 */
export interface SessionsCityAttachedTerminal {
  readonly attachment: ExternalSessionAttachment
  /** The row hvir already built for that terminal. */
  readonly session: SessionsObservedSession
}

/**
 * One interaction a city declared it is waiting on, as the host event streams
 * hold it. The projection never reads this from gc itself: the facts follow
 * open projects so that a blocked agent raises attention with no view open at
 * all (ADR-048), and the row simply reports what is already known.
 */
export interface SessionsCityPendingSignal {
  readonly hostId: HostId
  readonly sessionKey: string
  /** hvir has stopped watching the host that declared it. */
  readonly stale?: true
}

/**
 * The declared interactions in a set of hosts' facts, one per session.
 *
 * A session may be waiting on more than one interaction; a row is waiting or it
 * is not, so the count stays with the attention rollup that reports it. Facts
 * hvir has stopped watching are carried with the staleness intact.
 */
export function cityPendingSignals(
  events: readonly HostCityEvents[],
): readonly SessionsCityPendingSignal[] {
  const signals = new Map<string, SessionsCityPendingSignal>()
  for (const facts of events) {
    const stale = !hostCityEventsFresh(facts)
    for (const entry of facts.pending) {
      const key = pendingKey(facts.hostId, entry.sessionKey)
      if (signals.has(key)) continue
      signals.set(key, {
        hostId: facts.hostId,
        sessionKey: entry.sessionKey,
        ...(stale ? { stale: true } : {}),
      })
    }
  }
  return [...signals.values()]
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
  /** Terminals hvir holds for sessions in this set, if any. */
  readonly attached?: readonly SessionsCityAttachedTerminal[]
  /** Interactions the cities declared they are waiting on, if any. */
  readonly pending?: readonly SessionsCityPendingSignal[]
}

export interface SessionsCityProjection {
  readonly sessions: readonly SessionsObservedSession[]
  /**
   * The rows of attached terminals, re-presented as the sessions they attach
   * to, keyed by the terminal handle they keep. The caller replaces its own row
   * with this one: an attach is a capability the session's row gains, never a
   * second row (ADR-046).
   */
  readonly merged: ReadonlyMap<string, SessionsObservedSession>
  /** Present when at least one row needed the source's own provider identity. */
  readonly provider?: SessionsProviderProjection
}

export function projectCitySessions({
  cities,
  workspaces,
  identities,
  providers,
  capacity,
  attached = [],
  pending = [],
}: SessionsCityProjectionInput): SessionsCityProjection {
  const sessions: SessionsObservedSession[] = []
  const merged = new Map<string, SessionsObservedSession>()
  const attachedByDigest = new Map(
    attached
      .filter((terminal) => terminal.attachment.sourceId === 'gas-city')
      .map((terminal) => [terminal.attachment.sessionDigest, terminal] as const),
  )
  const pendingByKey = new Map(
    pending.map((signal) => [pendingKey(signal.hostId, signal.sessionKey), signal]),
  )
  let sourceProviderUsed = false
  for (const city of cities) {
    const placement = placementTargets(workspaces, city)
    if (placement.length === 0) continue
    for (const fact of city.sessions) {
      const target = externalTarget(fact, city)
      const waiting = pendingByKey.get(pendingKey(city.root.hostId, fact.sessionKey))
      const claimed = attachedByDigest.get(
        externalSessionDigest('gas-city', fact.sessionKey),
      )
      if (claimed !== undefined) {
        // An attached session is not a new row and does not consume capacity:
        // hvir already published a row for the terminal, and hvir's own
        // workspace placement for it beats anything inferred from gc's paths.
        const declared = declaredProvider(fact, providers)
        if (declared === undefined) sourceProviderUsed = true
        // The row keeps hvir's own handle, so the session it stands for is
        // recorded against that handle instead of minting a second one. A
        // detail pane can then read the session behind the terminal.
        identities.bindExternalSession(claimed.session.handle, target)
        merged.set(
          String(claimed.session.handle),
          attachedSession(claimed.session, fact, city, declared, waiting),
        )
        continue
      }
      if (sessions.length >= capacity) break
      const workspace = placeCitySession(fact, placement)
      if (workspace === undefined) continue
      const handle = identities.externalSession(target)
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
        telemetry: telemetryFor(fact, city, waiting),
        ...attentionFor(waiting, city),
      })
    }
  }
  return {
    sessions,
    merged,
    ...(sourceProviderUsed ? { provider: SESSIONS_GAS_CITY_PROVIDER } : {}),
  }
}

/**
 * What one projected row stands for, as main records it.
 *
 * The host is part of the identity, not context: two hosts run two supervisors,
 * and one gc session identifier can name a different session on each. The
 * attach target is gc's own alias, carried so an Attach can be composed without
 * the session identifier leaving this process.
 */
function externalTarget(
  fact: CitySessionFact,
  city: HostCitySessions,
): SessionsExternalSessionTarget {
  return {
    sourceId: 'gas-city',
    hostId: city.root.hostId,
    key: fact.sessionKey,
    attachTarget: fact.attachTarget,
    ...(city.cityRoot === undefined ? {} : { cityRoot: city.cityRoot }),
  }
}

/**
 * The terminal's row, presented as the session it attached to.
 *
 * What hvir owns stays: the handle the renderer opens and focuses, the
 * workspace hvir placed it in, the live PTY, the lifecycle of its own process.
 * What the session is comes from gc: the origin, the harness identity, the
 * label, and the telemetry, because the terminal is a viewport onto a turn hvir
 * is not driving and hvir's provider adapter has nothing to report about it.
 * There is no profile behind the session itself, whatever profile hvir happened
 * to launch the viewing terminal with.
 */
function attachedSession(
  session: SessionsObservedSession,
  fact: CitySessionFact,
  city: HostCitySessions,
  declared: SessionsProviderProjection | undefined,
  waiting: SessionsCityPendingSignal | undefined,
): SessionsObservedSession {
  return {
    ...session,
    origin: SESSIONS_GAS_CITY_ORIGIN,
    providerId: declared?.id ?? SESSIONS_GAS_CITY_PROVIDER.id,
    profile: { status: 'unsupported' },
    title: sessionsProjectionDisplayTitle(fact.label, session.handle, session.title, [
      fact.sessionKey,
      fact.workDir?.path ?? '',
      fact.rigRoot?.path ?? '',
    ]),
    telemetry: telemetryFor(fact, city, waiting),
    ...attentionFor(waiting, city),
  }
}

/**
 * The workspaces on this city's host, as placement candidates. Mapped once per
 * city rather than per session: the rule is the same for every session in it.
 */
function placementTargets(
  workspaces: readonly SessionsCityWorkspaceTarget[],
  city: HostCitySessions,
): readonly CityPlacementTarget<SessionsWorkspaceProjection>[] {
  return workspaces
    .filter((target) => target.root.hostId === city.root.hostId)
    .map((target) => ({
      root: target.root,
      projectRoot: target.projectRoot,
      projectKey: String(target.workspace.projectId),
      main: target.workspace.main,
      value: target.workspace,
    }))
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
  waiting: SessionsCityPendingSignal | undefined,
): SessionsTelemetryFacts {
  const observedAt = city.observedAt
  return {
    model: { status: 'unsupported' },
    context: contextFact(fact, city),
    turn: turnFact(waiting, city),
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

/** The host and session a declared interaction belongs to, as one key. */
function pendingKey(hostId: HostId, sessionKey: string): string {
  return `${hostId}\u0000${sessionKey}`
}

/**
 * The row's attention, when an interaction was declared for it.
 *
 * Nothing is reported when nothing was declared: a source that is not waiting
 * on a person has said nothing about unseen output, and hvir renders no
 * terminal here to know it for itself. A declaration hvir has stopped watching
 * is marked stale with its reason rather than dropped or asserted (ADR-048).
 */
function attentionFor(
  waiting: SessionsCityPendingSignal | undefined,
  city: HostCitySessions,
): Pick<SessionsObservedSession, 'attention'> {
  if (waiting === undefined) return {}
  const value: SessionsAttentionValue = 'ready'
  return {
    attention:
      waiting.stale === true || city.stale
        ? {
            status: 'stale',
            value,
            observedAt: city.observedAt,
            reason: 'source-stale',
          }
        : { status: 'available', value, observedAt: city.observedAt },
  }
}

/**
 * The turn, from the same declaration. `waiting-for-user` is what a pending
 * interaction says: gc names its own kinds with its own words and declares no
 * vocabulary for them, so reading approval out of one would be a guess.
 */
function turnFact(
  waiting: SessionsCityPendingSignal | undefined,
  city: HostCitySessions,
): SessionsFact<SessionsTurnFact> {
  if (waiting === undefined) return { status: 'unsupported' }
  const value: SessionsTurnFact = { state: 'waiting-for-user' }
  return waiting.stale === true || city.stale
    ? { status: 'stale', value, observedAt: city.observedAt, reason: 'source-stale' }
    : { status: 'available', value, observedAt: city.observedAt }
}
