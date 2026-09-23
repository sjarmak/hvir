import { asHostId, hostPath } from '../src/shared'

export const HOST = asHostId('local')
export const CITY = '/home/dev/gas-city'
export const RIG_ROOT = hostPath(HOST, `${CITY}/rigs/mem`)
export const CITY_ROOT = hostPath(HOST, CITY)

export function sessionJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gc-11',
    name: 'mem-worker-ash',
    template: 'mem/mem-worker',
    state: 'active',
    provider: 'claude',
    work_dir: `${CITY}/rigs/mem`,
    ...overrides,
  }
}

/**
 * A resolved city config shaped the way `gc config show` composes one: a
 * suspended pack-stamped lead alongside the hand-defined city-scope lead that
 * replaced it, plus a pooled worker agent.
 */
export const RESOLVED_CONFIG = `
[[named_session]]
name = "mem-pl"
alias = "mem-pl"
agent = "mem-pl"
mode = "always"
work_dir = "${CITY}/rigs/mem"
rig = "mem"

[[named_session]]
name = "core.control-dispatcher"
agent = "control-dispatcher"
mode = "always"

[agents.mem-pl]
work_dir = "${CITY}/rigs/mem"

[agents.mem-worker]
namepool = "mem-worker"
min_active_sessions = 1
max_active_sessions = 4

[rigs.mem]
path = "${CITY}/rigs/mem"

[[rigs.mem.named_session]]
name = "project-lead"
agent = "project-lead"
mode = "always"
suspended = true
`
