/**
 * Where a host's gc supervisor is, and which city a project root belongs to.
 *
 * ADR-047 declares the endpoint rather than discovering it: gc's documented
 * loopback default, one optional override per host, and no scanning. Everything
 * here is pure, so the policy is testable without a host or a socket.
 */
import type { HostId, LoopbackEndpoint } from '../../shared'
import type { CityInfo } from './generated-supervisor-api'

/** gc binds its machine-wide supervisor here and documents no way to move it. */
export const GASCITY_SUPERVISOR_DEFAULT_ENDPOINT: LoopbackEndpoint = {
  hostname: '127.0.0.1',
  port: 8372,
}

/** Applies to every host with no override of its own. */
export const GASCITY_SUPERVISOR_VARIABLE = 'HVIR_GASCITY_SUPERVISOR'

/** The one value that turns the surface off instead of moving it. */
const OFF = 'off'

type Env = Readonly<Record<string, string | undefined>>

/**
 * Absent because the user said so, or absent because the declaration was unusable.
 * Both hide the surface; only the second is worth reporting as a configuration fault.
 */
export type SupervisorEndpointDeclaration =
  | { readonly kind: 'endpoint'; readonly endpoint: LoopbackEndpoint }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'invalid'; readonly variable: string }

/** `HVIR_GASCITY_SUPERVISOR_SSH_BUILD_BOX` overrides the host named `ssh-build-box`. */
export function supervisorVariableForHost(hostId: HostId): string {
  const suffix = hostId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
  return `${GASCITY_SUPERVISOR_VARIABLE}_${suffix}`
}

function readVariable(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** A bare port, or a loopback authority. Any other authority is not reachable here. */
function parseAuthority(value: string): LoopbackEndpoint | undefined {
  const bare = /^[0-9]{1,5}$/.test(value)
  const target = bare ? `127.0.0.1:${value}` : value
  const parsed = /^(\[::1\]|::1|127\.0\.0\.1|localhost):([0-9]{1,5})$/.exec(target)
  if (!parsed) return undefined
  const port = Number(parsed[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  const hostname = parsed[1] === '[::1]' ? '::1' : parsed[1]
  return { hostname: hostname as LoopbackEndpoint['hostname'], port }
}

/**
 * The per-host override wins, then the shared one, then gc's documented default.
 * An unset or blank variable is not a declaration, so it falls through to the next.
 */
export function supervisorEndpointFor(
  hostId: HostId,
  env: Env,
): SupervisorEndpointDeclaration {
  for (const variable of [
    supervisorVariableForHost(hostId),
    GASCITY_SUPERVISOR_VARIABLE,
  ]) {
    const value = readVariable(env, variable)
    if (value === undefined) continue
    if (value.toLowerCase() === OFF) return { kind: 'disabled' }
    const endpoint = parseAuthority(value)
    return endpoint ? { kind: 'endpoint', endpoint } : { kind: 'invalid', variable }
  }
  return { kind: 'endpoint', endpoint: GASCITY_SUPERVISOR_DEFAULT_ENDPOINT }
}

/**
 * hvir resolves a city root; the API is keyed by city name. The supervisor reports
 * both, so the join is exact and no name is ever guessed from a directory.
 */
export function supervisorCityNameForRoot(
  cities: readonly CityInfo[],
  root: string,
): string | undefined {
  const normalized = normalizeRoot(root)
  const matches = cities.filter((city) => normalizeRoot(city.path) === normalized)
  // Two cities claiming one path is a supervisor state hvir cannot arbitrate.
  return matches.length === 1 ? matches[0]!.name : undefined
}

function normalizeRoot(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}
