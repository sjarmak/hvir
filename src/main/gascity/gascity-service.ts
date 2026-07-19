import {
  dirnameHostPath,
  hostPath,
  hostPathEquals,
  isHostPathShape,
  joinHostPath,
  type GasCityCrewRequest,
  type GasCityCrewResponse,
  type GasCityProbeResponse,
  type GasCitySession,
  type GasCityTierSource,
  type GasCityUnavailable,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import { EMPTY_RESOLVED_CONFIG, parseResolvedConfig } from './gascity-config'
import {
  GasCityContextCache,
  isCityWorkspace,
  type GasCityContext,
} from './gascity-context'
import { deriveCrew } from './gascity-crew'
import {
  hasProjectedTierFields,
  parseRigListOutput,
  parseSessionListOutput,
  rigForPath,
  type GasCityRig,
} from './gascity-parse'

/** Resolved config for a large city is well under a megabyte; leave headroom. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
/** How far up from the workspace root to look for a city marker. */
const MAX_CITY_WALK_DEPTH = 12

export interface GasCityServiceDeps {
  readonly getProject: () => { readonly host: ProjectHost; readonly root: HostPath }
}

interface GcResult {
  readonly ok: boolean
  readonly stdout: string
  readonly unavailable?: GasCityUnavailable
}

/**
 * Read-only bridge to the `gc` CLI for the active workspace, mirroring
 * `BeadsService`: every call goes through the `ProjectHost` seam, so the crew
 * view works for local and SSH projects alike wherever `gc` is installed.
 *
 * Phase 1 derives the crew tiering from `gc session list --json` plus the
 * resolved config. When gc itself starts projecting the tiering fields into the
 * session list, {@link hasProjectedTierFields} detects it and the config read is
 * skipped entirely.
 */
export class GasCityService {
  /**
   * The city's shape, cached per workspace. Only the session list is re-read
   * every poll; see `gascity-context.ts` for why the rest must not be.
   */
  private readonly contexts = new GasCityContextCache({
    load: (root, withConfig) => this.loadContext(root, withConfig),
  })

  constructor(private readonly deps: GasCityServiceDeps) {}

  async crew(req: GasCityCrewRequest): Promise<GasCityCrewResponse> {
    const { host, root } = this.activeProject(req.root)
    if (req.refresh === true) this.contexts.invalidate(root)
    const listed = await this.run(host, root, ['session', 'list', '--json'])
    if (!listed.ok) return listed.unavailable as GasCityUnavailable

    let sessions: readonly GasCitySession[]
    try {
      sessions = parseSessionListOutput(listed.stdout, root.hostId)
    } catch (reason) {
      return failure('error', reason)
    }

    const tierSource: GasCityTierSource = hasProjectedTierFields(sessions)
      ? 'session-fields'
      : 'config'
    // Best-effort enrichments: without them the crew degrades to "every session
    // in this directory is a worker", which is wrong but not misleading, and the
    // failure is logged rather than blanking the section.
    const context = await this.contexts.get(root, tierSource === 'config')

    return deriveCrew({
      sessions,
      config: context.config,
      rigRoot: root,
      cityWorkspace: isCityWorkspace(context, root),
      includeInternals: req.includeInternals === true,
      tierSource,
      ...(context.rigName === undefined ? {} : { rigName: context.rigName }),
      ...(context.cityRoot === undefined ? {} : { cityRoot: context.cityRoot }),
      ...(context.hqRigName === undefined ? {} : { hqRigName: context.hqRigName }),
    })
  }

  private async loadContext(
    root: HostPath,
    withConfig: boolean,
  ): Promise<GasCityContext> {
    const { host } = this.activeProject(root)
    const [rigs, config] = await Promise.all([
      this.resolveRigs(host, root),
      withConfig
        ? this.resolveConfig(host, root)
        : Promise.resolve(EMPTY_RESOLVED_CONFIG),
    ])
    const rigName = rigForPath(rigs, root.path)?.name
    const { cityRoot, hqRigName } = await this.resolveCity(host, root, rigs)
    return {
      config,
      ...(rigName === undefined ? {} : { rigName }),
      ...(cityRoot === undefined ? {} : { cityRoot }),
      ...(hqRigName === undefined ? {} : { hqRigName }),
    }
  }

  /**
   * Does this workspace sit inside a Gas City? A bounded walk up from the root
   * looking for `city.toml` or `.gc` — no `gc` invocation, so it stays cheap
   * enough to run on every workspace switch.
   */
  async probe(requestedRoot: HostPath): Promise<GasCityProbeResponse> {
    const { host, root } = this.activeProject(requestedRoot)
    return { hasCity: await isInCity(host, root) }
  }

  private async resolveRigs(
    host: ProjectHost,
    root: HostPath,
  ): Promise<readonly GasCityRig[]> {
    const result = await this.run(host, root, ['rig', 'list', '--json'])
    return result.ok ? parseRigListOutput(result.stdout) : []
  }

  /**
   * Locate the city and its HQ rig.
   *
   * `gc rig list` reports the HQ rig — the city itself — alongside every
   * registered rig, so the city is found by asking which listed rig root carries
   * `city.toml`. That works for rigs registered *outside* the city directory,
   * where walking up from the workspace never reaches the city at all and the
   * mayor would otherwise vanish from the crew. The walk stays as the fallback
   * for when the rig list is unavailable.
   */
  private async resolveCity(
    host: ProjectHost,
    root: HostPath,
    rigs: readonly GasCityRig[],
  ): Promise<{ readonly cityRoot?: HostPath; readonly hqRigName?: string }> {
    // Stat every rig at once: a city has tens of rigs and these are round trips
    // over SSH, so doing them in sequence is the difference between snappy and
    // not on the first load.
    const marked = await Promise.all(
      rigs.map(async (rig) => {
        const candidate = hostPath(root.hostId, rig.path)
        return (await hasMarker(host, candidate, [CITY_ROOT_MARKER]))
          ? { cityRoot: candidate, hqRigName: rig.name }
          : undefined
      }),
    )
    const found = marked.find((entry) => entry !== undefined)
    if (found) return found
    const walked = await findCityRoot(host, root)
    return walked === undefined ? {} : { cityRoot: walked }
  }

  private async resolveConfig(
    host: ProjectHost,
    root: HostPath,
  ): Promise<ReturnType<typeof parseResolvedConfig>> {
    const result = await this.run(host, root, ['config', 'show'])
    if (!result.ok) return EMPTY_RESOLVED_CONFIG
    try {
      return parseResolvedConfig(result.stdout)
    } catch (reason) {
      console.error('[gascity] resolved config unparseable; crew tiering degraded', reason)
      return EMPTY_RESOLVED_CONFIG
    }
  }

  /**
   * `gc` is a user-installed CLI that commonly lives in `~/.local/bin`, which a
   * non-login shell (SSH exec) or a GUI-launched app's minimal PATH does not
   * include. Route through the host's login shell so it resolves the same way it
   * does in an interactive terminal.
   */
  private async run(
    host: ProjectHost,
    root: HostPath,
    args: readonly string[],
  ): Promise<GcResult> {
    let result
    try {
      result = await host.exec('gc', args, {
        cwd: root,
        maxBuffer: MAX_OUTPUT_BYTES,
        loginShell: true,
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      logFailure(root, args, message)
      return {
        ok: false,
        stdout: '',
        unavailable: /ENOENT|not found/i.test(message)
          ? { available: false, reason: 'gc-missing', message: 'The gc CLI is not installed on this host.' }
          : { available: false, reason: 'error', message },
      }
    }
    if (result.code !== 0) {
      const stderr = result.stderr.trim()
      logFailure(root, args, stderr)
      return { ok: false, stdout: '', unavailable: classifyFailure(stderr) }
    }
    return { ok: true, stdout: result.stdout }
  }

  /**
   * The panel only ever asks about the active workspace; anything else is
   * rejected before a path reaches exec. The trusted registry root is used from
   * here on, never the renderer-supplied value.
   */
  private activeProject(requested: HostPath): {
    readonly host: ProjectHost
    readonly root: HostPath
  } {
    const project = this.deps.getProject()
    if (!isHostPathShape(requested) || !hostPathEquals(requested, project.root)) {
      throw new Error('Gas City requests are limited to the active workspace root')
    }
    return project
  }
}

/**
 * `city.toml` marks the city root and nothing else. `.gc` does **not**: gc
 * creates one inside every registered rig, so treating it as a city marker made
 * every rig workspace look like the orchestration workspace and showed the whole
 * city everywhere. Membership and identity are two different questions and need
 * two different markers.
 */
const CITY_ROOT_MARKER = 'city.toml'
const CITY_MEMBER_MARKERS = [CITY_ROOT_MARKER, '.gc'] as const

/**
 * The root of the city enclosing `start`, by a bounded walk up. Whether that
 * root *is* the workspace is what separates the orchestration view from a rig
 * view, so this tests for `city.toml` alone.
 */
async function findCityRoot(
  host: ProjectHost,
  start: HostPath,
): Promise<HostPath | undefined> {
  return walkUp(start, (directory) => hasMarker(host, directory, [CITY_ROOT_MARKER]))
}

/**
 * Is `start` inside a city at all? Broader than {@link findCityRoot}: a rig
 * registered with a city carries `.gc` even when the city root is somewhere the
 * walk cannot reach.
 */
async function isInCity(host: ProjectHost, start: HostPath): Promise<boolean> {
  return (
    (await walkUp(start, (directory) => hasMarker(host, directory, CITY_MEMBER_MARKERS))) !==
    undefined
  )
}

async function walkUp(
  start: HostPath,
  test: (directory: HostPath) => Promise<boolean>,
): Promise<HostPath | undefined> {
  let current = start
  for (let depth = 0; depth < MAX_CITY_WALK_DEPTH; depth += 1) {
    if (await test(current)) return current
    const parent = dirnameHostPath(current)
    if (hostPathEquals(parent, current)) break
    current = parent
  }
  return undefined
}

async function hasMarker(
  host: ProjectHost,
  directory: HostPath,
  markers: readonly string[],
): Promise<boolean> {
  for (const marker of markers) {
    try {
      await host.stat(joinHostPath(directory, marker))
      return true
    } catch {
      // Marker absent at this level; try the next marker, then the parent.
    }
  }
  return false
}

function classifyFailure(stderr: string): GasCityUnavailable {
  if (/not in a city directory|no city\.toml/i.test(stderr)) {
    return {
      available: false,
      reason: 'no-city',
      message: 'This workspace is not inside a Gas City.',
    }
  }
  return {
    available: false,
    reason: 'error',
    message: stderr === '' ? 'gc exited with a non-zero status.' : stderr,
  }
}

function failure(reason: GasCityUnavailable['reason'], cause: unknown): GasCityUnavailable {
  return {
    available: false,
    reason,
    message: cause instanceof Error ? cause.message : String(cause),
  }
}

function logFailure(root: HostPath, args: readonly string[], detail: string): void {
  console.error('[gascity] command failed', {
    root: root.path,
    args: args.join(' '),
    detail,
  })
}
