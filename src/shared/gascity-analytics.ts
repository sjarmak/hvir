/**
 * Overlay-only defaults (feat/beads-panel). The team slug, environment, dataset,
 * Omni origin, dashboard id and rig filter id below are Honeycomb/Omni UI path
 * segments for Stephanie's workspace, not secrets and not upstream hvir
 * configuration; override or disable through the environment. No API key is
 * ever read here.
 *
 * One absence rule, applied to every variable: unset or blank means "use the
 * overlay default", so a fresh shell shows both surfaces; an explicit value that
 * fails validation, or the literal `off`, hides that surface (its config field
 * is undefined and the panel renders no link). That is the "not configured"
 * degrade path. `off` is spelled out because it would otherwise pass the
 * path-segment rule and turn into a Honeycomb 404 instead of a hidden link.
 */

/** Where the Honeycomb query UI lives for the traced dataset. */
export interface HoneycombLinkConfig {
  readonly team: string
  readonly environment: string
  readonly dataset: string
}

/** Where the Omni "Gas City Analytics" model lives, and how to filter it. */
export interface OmniLinkConfig {
  /** An https origin with no path, query, fragment or credentials. */
  readonly baseUrl: string
  readonly dashboardId?: string
  /** Omni dashboard filter id whose values are rig names. */
  readonly rigFilterId?: string
}

/** A surface absent here is hidden in the panel. */
export interface GasCityAnalyticsConfig {
  readonly honeycomb?: HoneycombLinkConfig
  readonly omni?: OmniLinkConfig
}

export type GasCityAnalyticsConfigRequest = Record<string, never>

export const HONEYCOMB_LINK_DEFAULTS: HoneycombLinkConfig = {
  team: 'steph.jarmak',
  environment: 'test',
  dataset: 'gas-city-agent',
}

export const OMNI_DEFAULT_BASE_URL = 'https://sjarmak.omniapp.co'
/** The "Factory Health by Rig" document and its UI-created rig filter; recreating either mints a new id. */
export const OMNI_DEFAULT_DASHBOARD_ID = 'gas-city-factory-rig-health'
export const OMNI_DEFAULT_RIG_FILTER_ID = 'QMdNGURu'

/**
 * Mirrors gas-city's `_gc_seat_trace_safe_component` (bin/lib/gc-seat-tracing.sh):
 * the only characters gas-city lets into an exported identity. Applied to every
 * URL path segment and filter value here so no link carries a value the trace
 * pipeline could never have produced.
 */
export const SAFE_COMPONENT = /^[A-Za-z0-9_.-]{1,64}$/

type Env = Readonly<Record<string, string | undefined>>

/** The one value that disables a surface outright rather than configuring it. */
const OFF = 'off'

function readVar(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function isOff(value: string | undefined): boolean {
  return value !== undefined && value.toLowerCase() === OFF
}

function honeycombFromEnv(env: Env): HoneycombLinkConfig | undefined {
  const team = readVar(env, 'HONEYCOMB_TEAM')
  const environment = readVar(env, 'HONEYCOMB_ENVIRONMENT')
  const dataset = readVar(env, 'HONEYCOMB_TRACE_DATASET')
  if ([team, environment, dataset].some(isOff)) return undefined
  const config: HoneycombLinkConfig = {
    team: team ?? HONEYCOMB_LINK_DEFAULTS.team,
    environment: environment ?? HONEYCOMB_LINK_DEFAULTS.environment,
    dataset: dataset ?? HONEYCOMB_LINK_DEFAULTS.dataset,
  }
  const segments = [config.team, config.environment, config.dataset]
  return segments.every((segment) => SAFE_COMPONENT.test(segment)) ? config : undefined
}

function omniOrigin(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const bare =
    url.protocol === 'https:' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  return bare ? url.origin : undefined
}

/** Unset or blank takes the default; `off` or an unsafe value drops the id. */
function omniIdVar(
  env: Env,
  name: string,
  fallback: string | undefined,
): string | undefined {
  const value = readVar(env, name)
  if (value === undefined) return fallback
  return !isOff(value) && SAFE_COMPONENT.test(value) ? value : undefined
}

function omniFromEnv(env: Env): OmniLinkConfig | undefined {
  const raw = readVar(env, 'OMNI_BASE_URL')
  if (isOff(raw)) return undefined
  const baseUrl = omniOrigin(raw ?? OMNI_DEFAULT_BASE_URL)
  if (baseUrl === undefined) return undefined
  // The default ids name a document in the default workspace, so another origin gets none.
  const workspaceDefault = baseUrl === OMNI_DEFAULT_BASE_URL
  const dashboardId = omniIdVar(
    env,
    'OMNI_DASHBOARD_ID',
    workspaceDefault ? OMNI_DEFAULT_DASHBOARD_ID : undefined,
  )
  const rigFilterId = omniIdVar(
    env,
    'OMNI_RIG_FILTER_ID',
    workspaceDefault ? OMNI_DEFAULT_RIG_FILTER_ID : undefined,
  )
  return {
    baseUrl,
    ...(dashboardId === undefined ? {} : { dashboardId }),
    ...(rigFilterId === undefined ? {} : { rigFilterId }),
  }
}

/** Pure: the environment in, the link configuration out. Never reads a key. */
export function analyticsConfigFromEnv(env: Env): GasCityAnalyticsConfig {
  const honeycomb = honeycombFromEnv(env)
  const omni = omniFromEnv(env)
  return {
    ...(honeycomb === undefined ? {} : { honeycomb }),
    ...(omni === undefined ? {} : { omni }),
  }
}
