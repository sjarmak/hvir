import {
  analyticsConfigFromEnv,
  hostPathEquals,
  isHostPathShape,
  type GasCityAnalyticsConfig,
  type GasCityCrewRequest,
  type GasCityCrewResponse,
  type GasCityProbeResponse,
  type GasCitySession,
  type GasCityTierSource,
  type GasCityUnavailable,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import { isCityWorkspace } from './gascity-context'
import { deriveCrew } from './gascity-crew'
import { hasProjectedTierFields } from './gascity-parse'
import { GasCityReadError, GasCityReader, type GasCityTarget } from './gascity-reader'

export interface GasCityServiceDeps {
  readonly getProject: () => { readonly host: ProjectHost; readonly root: HostPath }
  /** Injectable for tests; defaults to `Date.now`. Drives the read caches. */
  readonly now?: () => number
  /** Process environment for the non-secret analytics link configuration. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * The shared reader. Passing the one the Sessions projection also uses is
   * what makes a global view cost no extra `gc` reads; without it the service
   * reads on its own, which is right for tests and for the smoke fixture.
   */
  readonly reader?: GasCityReader
}

/**
 * Read-only bridge to the `gc` CLI for the active workspace, mirroring
 * `BeadsService`: every call goes through the `ProjectHost` seam, so the crew
 * view works for local and SSH projects alike wherever `gc` is installed.
 *
 * The service owns the *authority* — the panel only ever asks about the active
 * workspace — while {@link GasCityReader} owns the reads and their caches.
 *
 * Phase 1 derives the crew tiering from `gc session list --json` plus the
 * resolved config. When gc itself starts projecting the tiering fields into the
 * session list, {@link hasProjectedTierFields} detects it and the config read is
 * skipped entirely.
 */
export class GasCityService {
  private readonly reader: GasCityReader

  constructor(private readonly deps: GasCityServiceDeps) {
    this.reader =
      deps.reader ?? new GasCityReader(deps.now === undefined ? {} : { now: deps.now })
  }

  async crew(req: GasCityCrewRequest): Promise<GasCityCrewResponse> {
    const target = this.activeProject(req.root)
    const { root } = target
    if (req.refresh === true) this.reader.invalidate(root)

    let sessions: readonly GasCitySession[]
    try {
      sessions = await this.reader.sessions(target)
    } catch (reason) {
      return reason instanceof GasCityReadError
        ? reason.unavailable
        : failure('error', reason)
    }

    const tierSource: GasCityTierSource = hasProjectedTierFields(sessions)
      ? 'session-fields'
      : 'config'
    // Best-effort enrichments: without them the crew degrades to "every session
    // in this directory is a worker", which is wrong but not misleading, and the
    // failure is logged rather than blanking the section.
    const context = await this.reader.context(target, tierSource === 'config')
    // None of the host-wide reads could know their city; now that one is
    // resolved, say so, so a workspace in a different city on this host misses
    // rather than being served this one's crew.
    this.reader.attribute(root.hostId, context.cityRoot)

    return deriveCrew({
      sessions,
      config: context.config,
      rigs: context.rigs,
      rigRoot: root,
      cityWorkspace: isCityWorkspace(context, root),
      includeInternals: req.includeInternals === true,
      tierSource,
      ...(context.rigName === undefined ? {} : { rigName: context.rigName }),
      ...(context.cityRoot === undefined ? {} : { cityRoot: context.cityRoot }),
      ...(context.hqRigName === undefined ? {} : { hqRigName: context.hqRigName }),
    })
  }

  /**
   * Does this workspace sit inside a Gas City? Marker stats only, no `gc`
   * invocation, so it stays cheap enough to run on every workspace switch.
   */
  async probe(requestedRoot: HostPath): Promise<GasCityProbeResponse> {
    return { hasCity: await this.reader.inCity(this.activeProject(requestedRoot)) }
  }

  /**
   * Where the Honeycomb and Omni links point. Pure over the environment: no
   * exec, no workspace, so no `activeProject` guard. Never carries a key.
   */
  analyticsConfig(): GasCityAnalyticsConfig {
    return analyticsConfigFromEnv(this.deps.env ?? {})
  }

  /**
   * The panel only ever asks about the active workspace; anything else is
   * rejected before a path reaches exec. The trusted registry root is used from
   * here on, never the renderer-supplied value.
   */
  private activeProject(requested: HostPath): GasCityTarget {
    const project = this.deps.getProject()
    if (!isHostPathShape(requested) || !hostPathEquals(requested, project.root)) {
      throw new Error('Gas City requests are limited to the active workspace root')
    }
    return project
  }
}

function failure(reason: GasCityUnavailable['reason'], cause: unknown): GasCityUnavailable {
  return {
    available: false,
    reason,
    message: cause instanceof Error ? cause.message : String(cause),
  }
}
