import {
  dirnameHostPath,
  hostPath,
  hostPathEquals,
  joinHostPath,
  type GasCitySession,
  type GasCityUnavailable,
  type HostId,
  type HostPath,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import { isExecTimeout } from '../project-host/exec-timeout'
import {
  EMPTY_RESOLVED_CONFIG,
  parseResolvedConfig,
  type GasCityResolvedConfig,
} from './gascity-config'
import {
  CONTEXT_TTL_MS,
  GasCityContextCache,
  type GasCityContext,
} from './gascity-context'
import { HostReadCache, SESSION_TTL_MS } from './gascity-host-cache'
import {
  isRecord,
  parseRigListOutput,
  parseSessionListOutput,
  rigForPath,
  type GasCityRig,
} from './gascity-parse'

/** Resolved config for a large city is well under a megabyte; leave headroom. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
/** How far up from the workspace root to look for a city marker. */
const MAX_CITY_WALK_DEPTH = 12
/**
 * How long a single `gc` read may take before the reader gives up on it.
 *
 * On a real city `gc session list` runs about three seconds, so this is roughly
 * a 5x headroom over the slowest healthy read — long enough that a merely busy
 * city still loads, short enough that a wedged `gc` surfaces as an error inside
 * one poll instead of silently freezing the section forever. `gc` runs on the
 * one-slot background lane, so an unbounded read blocks every later poll too.
 */
const GC_TIMEOUT_MS = 15_000

/** One `gc` read, against the host that owns the workspace it is made from. */
export interface GasCityTarget {
  readonly host: ProjectHost
  readonly root: HostPath
}

/** A gc read that failed, carrying the reason a consumer should show. */
export class GasCityReadError extends Error {
  constructor(readonly unavailable: GasCityUnavailable) {
    super(unavailable.message)
  }
}

interface GcResult {
  readonly ok: boolean
  readonly stdout: string
  readonly unavailable?: GasCityUnavailable
}

/**
 * Every `gc` read hvir makes, cached and shared.
 *
 * The reader is deliberately ignorant of which workspace is active: it takes
 * the host and root it is asked about. That is what lets the per-workspace crew
 * view and the global Sessions projection share one `gc session list` per host
 * instead of each paying for its own. Authority over *which* roots may be read
 * stays with the callers — {@link GasCityService} limits itself to the active
 * workspace, and the Sessions source reads only hosts hvir has already
 * connected.
 */
export class GasCityReader {
  /**
   * The city's shape, cached per workspace. Only the session list is re-read
   * every poll; see `gascity-context.ts` for why the rest must not be.
   */
  private readonly contexts: GasCityContextCache<GasCityTarget>
  /**
   * Every `gc` read, shared per host. All three are city-wide; see
   * `gascity-host-cache.ts` for why the key is the host and not the city.
   */
  private readonly sessionLists: HostReadCache<readonly GasCitySession[], GasCityTarget>
  private readonly rigLists: HostReadCache<readonly GasCityRig[], GasCityTarget>
  private readonly configs: HostReadCache<GasCityResolvedConfig, GasCityTarget>
  private readonly listeners = new Set<() => void>()

  constructor(options: { readonly now?: () => number } = {}) {
    const clock = options.now === undefined ? {} : { now: options.now }
    this.contexts = new GasCityContextCache<GasCityTarget>({
      load: (target, withConfig) => this.loadContext(target, withConfig),
      ...clock,
    })
    this.sessionLists = new HostReadCache<readonly GasCitySession[], GasCityTarget>({
      load: (target) => this.loadSessions(target),
      ttlMs: SESSION_TTL_MS,
      ...clock,
    })
    this.rigLists = new HostReadCache<readonly GasCityRig[], GasCityTarget>({
      load: (target) => this.loadRigs(target),
      ttlMs: CONTEXT_TTL_MS,
      ...clock,
    })
    this.configs = new HostReadCache<GasCityResolvedConfig, GasCityTarget>({
      load: (target) => this.loadConfig(target),
      ttlMs: CONTEXT_TTL_MS,
      ...clock,
    })
  }

  /**
   * Fires when a fresh session list lands, so a consumer that did not ask for
   * the read still sees the result. This is how the Sessions projection stays
   * current without owning a timer of its own: whichever surface is polling
   * pays for the read, and everyone watching re-derives from it.
   */
  observe(listener: () => void): Disposer {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The live half: every session gc reports on this host. */
  sessions(target: GasCityTarget): Promise<readonly GasCitySession[]> {
    return this.sessionLists.get(target, this.contexts.peek(target.root)?.cityRoot)
  }

  /** The slow half: rigs, city root, hq rig, and the resolved config. */
  context(target: GasCityTarget, withConfig: boolean): Promise<GasCityContext> {
    return this.contexts.get(target, withConfig)
  }

  /** What is already known about a workspace's city, without starting a read. */
  peekContext(root: HostPath): GasCityContext | undefined {
    return this.contexts.peek(root)
  }

  /**
   * Record which city a host's cached reads described. None of the host-wide
   * reads could know their city when they were made, so a workspace in a
   * different city on the same host misses rather than being served this one's.
   */
  attribute(hostId: HostId, city: HostPath | undefined): void {
    for (const cache of this.hostReads) cache.attribute(hostId, city)
  }

  /** Drop everything cached for one workspace, and every host-wide read. */
  invalidate(root: HostPath): void {
    this.contexts.invalidate(root)
    for (const cache of this.hostReads) cache.invalidate()
  }

  /**
   * Does this workspace sit inside a Gas City? A bounded walk up from the root
   * looking for `city.toml` or `.gc` — no `gc` invocation, so it stays cheap
   * enough to run on every workspace switch, and a workspace with no city
   * costs no `gc` read at all.
   */
  async inCity({ host, root }: GasCityTarget): Promise<boolean> {
    return (
      (await walkUp(root, (directory) =>
        hasMarker(host, directory, CITY_MEMBER_MARKERS),
      )) !== undefined
    )
  }

  /** The host-wide reads, for the operations that apply to all of them alike. */
  private get hostReads(): readonly HostReadCache<unknown, GasCityTarget>[] {
    return [this.sessionLists, this.rigLists, this.configs]
  }

  /**
   * One `gc session list` read, parsed. Throws rather than returning a failure
   * shape so the cache evicts it: a transient gc failure must not pin an empty
   * crew in place for the share window.
   */
  private async loadSessions(
    target: GasCityTarget,
  ): Promise<readonly GasCitySession[]> {
    const listed = await this.run(target, ['session', 'list', '--json'])
    if (!listed.ok) throw new GasCityReadError(listed.unavailable as GasCityUnavailable)
    const sessions = parseSessionListOutput(listed.stdout, target.root.hostId)
    for (const listener of this.listeners) listener()
    return sessions
  }

  /**
   * The city's shape as this workspace sees it.
   *
   * Both `gc` reads here are city-wide and shared per host; what is left to do
   * per workspace is the rig it maps to — a pure lookup in the shared rig list —
   * and the marker stats that locate the city. A degraded read still yields a
   * workers-only crew rather than a blank section, so a failure is swallowed
   * here rather than in the cache, which must evict it.
   */
  private async loadContext(
    target: GasCityTarget,
    withConfig: boolean,
  ): Promise<GasCityContext> {
    const { root } = target
    const [rigs, config] = await Promise.all([
      this.rigLists
        .get(target)
        .catch(degradeTo<readonly GasCityRig[]>([], root, 'rig list')),
      withConfig
        ? this.configs
            .get(target)
            .catch(degradeTo(EMPTY_RESOLVED_CONFIG, root, 'config show'))
        : Promise.resolve(EMPTY_RESOLVED_CONFIG),
    ])
    const rigName = rigForPath(rigs, root.path)?.name
    const { cityRoot, hqRigName } = await this.resolveCity(target, rigs)
    return {
      rigs,
      config,
      ...(rigName === undefined ? {} : { rigName }),
      ...(cityRoot === undefined ? {} : { cityRoot }),
      ...(hqRigName === undefined ? {} : { hqRigName }),
    }
  }

  private async loadRigs(target: GasCityTarget): Promise<readonly GasCityRig[]> {
    const result = await this.run(target, ['rig', 'list', '--json'])
    if (!result.ok) throw new GasCityReadError(result.unavailable as GasCityUnavailable)
    return parseRigListOutput(result.stdout)
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
    { host, root }: GasCityTarget,
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
    const walked = await walkUp(root, (directory) =>
      hasMarker(host, directory, [CITY_ROOT_MARKER]),
    )
    return walked === undefined ? {} : { cityRoot: walked }
  }

  /**
   * A failed read throws so the cache evicts it; output gc produced but hvir
   * cannot parse is a real answer, cached as the empty config it amounts to.
   */
  private async loadConfig(target: GasCityTarget): Promise<GasCityResolvedConfig> {
    const result = await this.run(target, ['config', 'show'])
    if (!result.ok) throw new GasCityReadError(result.unavailable as GasCityUnavailable)
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
   *
   * The background lane is not an optimization, it is containment. On a real
   * city `gc session list` takes about three seconds and `gc rig list` about the
   * same, against tens of milliseconds for `bd` or `git status`. The host's
   * buffered-exec budget is shared by every subsystem, so without a cap a crew
   * poll on a 4-second timer holds most of it, and the git discovery a user is
   * waiting on after a workspace switch queues behind gc. Capping gc at one slot
   * makes a slow city cost the crew section its own latency and nothing else.
   */
  private async run(
    { host, root }: GasCityTarget,
    args: readonly string[],
  ): Promise<GcResult> {
    let result
    try {
      result = await host.exec('gc', args, {
        cwd: root,
        maxBuffer: MAX_OUTPUT_BYTES,
        loginShell: true,
        lane: 'background',
        timeout: GC_TIMEOUT_MS,
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      logFailure(root, args, message)
      // A timeout is its own diagnosis: gc is installed and the host is
      // reachable, it just never answered. Saying so beats "error", which reads
      // as a broken install and sends the user looking in the wrong place.
      if (isExecTimeout(reason)) {
        return {
          ok: false,
          stdout: '',
          unavailable: {
            available: false,
            reason: 'error',
            message: `gc ${args.join(' ')} did not respond within ${reason.timeoutMs / 1000}s.`,
          },
        }
      }
      return {
        ok: false,
        stdout: '',
        unavailable: /ENOENT|not found/i.test(message)
          ? {
              available: false,
              reason: 'gc-missing',
              message: 'The gc CLI is not installed on this host.',
            }
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

/**
 * gc reports failures two ways: a one-line message, or (under `--json`) a
 * structured envelope whose `message` carries the same text. Both classify the
 * same, so the envelope is unwrapped first and the rest reads the message.
 *
 * A store gc never provisioned is the second "no city" signal. gc accepts a
 * stray `.gc/` as a city marker and only then fails on the first bd read, with
 * bd rejecting the `session` issue type that `gc init` would have registered.
 * That is a plain beads workspace, not a broken city, so it hides like one.
 */
function classifyFailure(stderr: string): GasCityUnavailable {
  const message = unwrapErrorEnvelope(stderr)
  if (/not in a city directory|no city\.toml|invalid issue type "session"/i.test(message)) {
    return {
      available: false,
      reason: 'no-city',
      message: 'This workspace is not inside a Gas City.',
    }
  }
  return {
    available: false,
    reason: 'error',
    message: message === '' ? 'gc exited with a non-zero status.' : message,
  }
}

function unwrapErrorEnvelope(stderr: string): string {
  if (!stderr.startsWith('{')) return stderr
  try {
    const parsed: unknown = JSON.parse(stderr)
    if (isRecord(parsed) && typeof parsed.message === 'string') return parsed.message
  } catch {
    // Not an envelope after all; the raw text is the best diagnosis available.
  }
  return stderr
}

/**
 * Fall back to `value` when an enrichment read fails. A partial crew beats a
 * blank section, so this is logged rather than surfaced — but it lives at the
 * call site, not in the cache, which has to evict the failure so the next
 * workspace on this host retries instead of inheriting it.
 */
function degradeTo<T>(value: T, root: HostPath, read: string): (reason: unknown) => T {
  return (reason) => {
    console.error('[gascity] enrichment unavailable; crew degraded', {
      root: root.path,
      read,
      detail: reason instanceof Error ? reason.message : String(reason),
    })
    return value
  }
}

function logFailure(root: HostPath, args: readonly string[], detail: string): void {
  console.error('[gascity] command failed', {
    root: root.path,
    args: args.join(' '),
    detail,
  })
}
