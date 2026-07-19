import { describe, expect, it, vi } from 'vitest'

import { GasCityService } from '../src/main/gascity/gascity-service'
import type { ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, type ExecResult, type HostPath } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/home/dev/city/rigs/mem')

function execResult(code: number, stdout: string, stderr = ''): ExecResult {
  return { code, signal: null, stdout, stderr }
}

/**
 * A host whose `exec` answers per gc subcommand, so a test states only the
 * outputs it cares about and every unstubbed call fails loudly.
 */
function stubHost(
  responses: Readonly<Record<string, ExecResult | Error>>,
  stats: readonly string[] = [],
): { host: ProjectHost; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn((_command: string, args: readonly string[], _opts?: unknown) => {
    const key = args.slice(0, 2).join(' ')
    const response = responses[key]
    if (response === undefined) return Promise.reject(new Error(`unexpected gc: ${key}`))
    if (response instanceof Error) return Promise.reject(response)
    return Promise.resolve(response)
  })
  const stat = vi.fn((path: HostPath) =>
    stats.includes(path.path)
      ? Promise.resolve({ type: 'dir' as const, size: 0, mtimeMs: 0 })
      : Promise.reject(new Error('ENOENT: no such file or directory')),
  )
  return { host: { exec, stat } as unknown as ProjectHost, exec }
}

function service(host: ProjectHost): GasCityService {
  return new GasCityService({ getProject: () => ({ host, root: ROOT }) })
}

const RIG_LIST = execResult(
  0,
  JSON.stringify([{ name: 'mem', path: '/home/dev/city/rigs/mem' }]),
)
const CONFIG = execResult(
  0,
  `
[[named_session]]
name = "mem-pl"
mode = "always"
rig = "mem"
`,
)

describe('GasCityService', () => {
  it('derives a crew from the session list, rig list, and resolved config', async () => {
    const { host } = stubHost({
      'session list': execResult(
        0,
        JSON.stringify([
          {
            id: 'gc-1',
            name: 'mem-pl',
            state: 'active',
            work_dir: '/home/dev/city/rigs/mem',
          },
        ]),
      ),
      'rig list': RIG_LIST,
      'config show': CONFIG,
    })
    const crew = await service(host).crew({ root: ROOT })
    expect(crew.available).toBe(true)
    if (!crew.available) return
    expect(crew.tierSource).toBe('config')
    expect(crew.members.map((member) => [member.label, member.tier])).toEqual([
      ['mem-pl', 'lead'],
    ])
  })

  it('skips the config read once gc projects the tiering fields itself', async () => {
    const { host, exec } = stubHost({
      'session list': execResult(
        0,
        JSON.stringify([
          {
            id: 'gc-1',
            name: 'mayor',
            state: 'active',
            work_dir: '/home/dev/city/rigs/mem',
            configured_named_session: true,
          },
        ]),
      ),
      'rig list': RIG_LIST,
    })
    const crew = await service(host).crew({ root: ROOT })
    expect(crew.available).toBe(true)
    const invocations = exec.mock.calls.map((call) => (call[1] as string[])[0])
    expect(invocations).not.toContain('config')
  })

  it('reports a missing gc CLI rather than an empty crew', async () => {
    const { host } = stubHost({
      'session list': new Error('spawn gc ENOENT'),
    })
    const crew = await service(host).crew({ root: ROOT })
    expect(crew).toMatchObject({ available: false, reason: 'gc-missing' })
  })

  it('classifies a workspace outside a city', async () => {
    const { host } = stubHost({
      'session list': execResult(1, '', 'gc session list: not in a city directory'),
    })
    const crew = await service(host).crew({ root: ROOT })
    expect(crew).toMatchObject({ available: false, reason: 'no-city' })
  })

  it('degrades to workers when the rig and config reads fail', async () => {
    const { host } = stubHost({
      'session list': execResult(
        0,
        JSON.stringify([
          { id: 'gc-1', name: 'mem-pl', state: 'active', work_dir: '/home/dev/city/rigs/mem' },
        ]),
      ),
      'rig list': execResult(1, '', 'boom'),
      'config show': execResult(1, '', 'boom'),
    })
    const crew = await service(host).crew({ root: ROOT })
    expect(crew.available).toBe(true)
    if (!crew.available) return
    expect(crew.members.map((member) => member.tier)).toEqual(['worker'])
  })

  it('treats a workspace carrying the city marker as the whole-city view', async () => {
    const { host } = stubHost(
      {
        'session list': execResult(
          0,
          JSON.stringify([
            { id: 'gc-1', name: 'aoa-worker-elm', state: 'active', work_dir: '/elsewhere' },
          ]),
        ),
        'rig list': RIG_LIST,
        'config show': CONFIG,
      },
      // The workspace root itself carries the marker, so it is the city.
      [`${ROOT.path}/city.toml`],
    )
    const crew = await service(host).crew({ root: ROOT })
    expect(crew.available).toBe(true)
    if (!crew.available) return
    // A session rooted outside every rig is still in the city, so it shows here
    // and would not in a rig workspace. The city's dormant lead renders too.
    expect([...crew.members.map((member) => member.label)].sort()).toEqual([
      'aoa-worker-elm',
      'mem-pl',
    ])
  })

  it('finds the city through the rig list when the rig sits outside it', async () => {
    // `gc rig list` reports the HQ rig alongside the others, so the city is
    // found by asking which listed rig root carries city.toml — the walk up from
    // this workspace would never reach it.
    const { host } = stubHost(
      {
        'session list': execResult(
          0,
          JSON.stringify([
            { id: 'gc-1', name: 'mayor', state: 'active', work_dir: '/srv/city' },
            { id: 'gc-2', name: 'mem-pl', state: 'active', work_dir: ROOT.path },
          ]),
        ),
        'rig list': execResult(
          0,
          JSON.stringify([
            { name: 'hq', path: '/srv/city' },
            { name: 'mem', path: ROOT.path },
          ]),
        ),
        'config show': execResult(
          0,
          `
[[named_session]]
name = "mayor"
alias = "mayor"
mode = "always"

[[named_session]]
name = "mem-pl"
alias = "mem-pl"
mode = "always"
rig = "mem"
`,
        ),
      },
      ['/srv/city/city.toml'],
    )
    const crew = await service(host).crew({ root: ROOT })
    expect(crew.available).toBe(true)
    if (!crew.available) return
    expect(crew.scope).toBe('rig')
    expect([...crew.members.map((member) => member.label)].sort()).toEqual([
      'mayor',
      'mem-pl',
    ])
  })

  it('re-reads only the session list on a repeat poll', async () => {
    const { host, exec } = stubHost({
      'session list': execResult(0, JSON.stringify([])),
      'rig list': RIG_LIST,
      'config show': CONFIG,
    })
    const gascity = service(host)
    await gascity.crew({ root: ROOT })
    const afterFirst = exec.mock.calls.length
    await gascity.crew({ root: ROOT })
    const added = exec.mock.calls
      .slice(afterFirst)
      .map((call) => (call[1] as string[]).slice(0, 2).join(' '))
    // The city's shape is cached; re-composing it every poll is what made the
    // panel slow on a real city.
    expect(added).toEqual(['session list'])
  })

  it('re-reads the city shape when a refresh asks for it', async () => {
    const { host, exec } = stubHost({
      'session list': execResult(0, JSON.stringify([])),
      'rig list': RIG_LIST,
      'config show': CONFIG,
    })
    const gascity = service(host)
    await gascity.crew({ root: ROOT })
    const afterFirst = exec.mock.calls.length
    await gascity.crew({ root: ROOT, refresh: true })
    const added = exec.mock.calls
      .slice(afterFirst)
      .map((call) => (call[1] as string[]).slice(0, 2).join(' '))
    expect(added).toContain('config show')
  })

  it('runs every gc invocation on the background exec lane', async () => {
    const { host, exec } = stubHost({
      'session list': execResult(0, '[]'),
      'rig list': RIG_LIST,
      'config show': CONFIG,
    })
    await service(host).crew({ root: ROOT })
    expect(exec.mock.calls.length).toBeGreaterThan(0)
    for (const call of exec.mock.calls) {
      expect(call[2]).toMatchObject({ lane: 'background' })
    }
  })

  it('rejects a request for anything but the active workspace root', async () => {
    const { host } = stubHost({})
    await expect(
      service(host).crew({ root: hostPath(asHostId('local'), '/elsewhere') }),
    ).rejects.toThrow(/active workspace root/)
  })

  it('finds a city marker above the workspace root', async () => {
    const { host } = stubHost({}, ['/home/dev/city/city.toml'])
    await expect(service(host).probe(ROOT)).resolves.toEqual({ hasCity: true })
  })

  it('reports no city when no ancestor carries a marker', async () => {
    const { host } = stubHost({})
    await expect(service(host).probe(ROOT)).resolves.toEqual({ hasCity: false })
  })
})
