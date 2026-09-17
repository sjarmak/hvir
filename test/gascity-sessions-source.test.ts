import { describe, expect, it, vi } from 'vitest'

import type { GasCityContext } from '../src/main/gascity/gascity-context'
import {
  GasCitySessionsSource,
  type GasCitySessionsReader,
} from '../src/main/gascity/gascity-sessions-source'
import type { GasCityTarget } from '../src/main/gascity/gascity-reader'
import type { ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, type GasCitySession, type HostPath } from '../src/shared'

const LOCAL = asHostId('local')
const REMOTE = asHostId('build-box')
const CITY = hostPath(LOCAL, '/home/dev/city')
const MEM = hostPath(LOCAL, '/home/dev/city/rigs/mem')
const ELSEWHERE = hostPath(LOCAL, '/home/dev/plain-repo')

function host(): ProjectHost {
  return {} as unknown as ProjectHost
}

function target(root: HostPath): GasCityTarget {
  return { host: host(), root }
}

function session(id: string, name = id): GasCitySession {
  return { id, name, state: 'active', workDir: MEM }
}

const CONTEXT: GasCityContext = {
  rigs: [{ name: 'mem', path: MEM.path }],
  cityRoot: CITY,
  config: { agents: [], namedSessions: [] },
}

/**
 * A reader that answers from the test's own script and counts every call, so a
 * test can assert not only what the source produced but what it cost.
 */
function stubReader(
  options: {
    readonly cities?: readonly string[]
    readonly sessions?: readonly GasCitySession[]
    readonly failSessions?: boolean
  } = {},
) {
  const listeners = new Set<() => void>()
  const cities = options.cities ?? [MEM.path]
  const inCity = vi.fn((candidate: GasCityTarget) =>
    Promise.resolve(cities.includes(candidate.root.path)),
  )
  const sessions = vi.fn(() =>
    options.failSessions === true
      ? Promise.reject(new Error('gc session list failed'))
      : Promise.resolve(options.sessions ?? [session('gc-1', 'mem-worker-1')]),
  )
  const context = vi.fn(() => Promise.resolve(CONTEXT))
  const reader: GasCitySessionsReader = {
    inCity,
    sessions,
    context,
    attribute: vi.fn(),
    observe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    reader,
    inCity,
    sessions,
    context,
    observerCount: () => listeners.size,
    announce: () => {
      for (const listener of listeners) listener()
    },
  }
}

function source(
  reader: GasCitySessionsReader,
  initial: readonly GasCityTarget[],
): {
  source: GasCitySessionsSource
  setCandidates: (next: readonly GasCityTarget[]) => void
} {
  const listeners = new Set<() => void>()
  let candidates = initial
  return {
    source: new GasCitySessionsSource({
      reader,
      candidates: () => candidates,
      observeCandidates: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      now: () => 1_000,
      warn: () => undefined,
    }),
    setCandidates: (next) => {
      candidates = next
      for (const listener of listeners) listener()
    },
  }
}

/** Let the source's in-flight reads settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('GasCitySessionsSource', () => {
  it('reads nothing until something is watching', async () => {
    const stub = stubReader()
    const { source: cities } = source(stub.reader, [target(MEM)])
    await settle()
    expect(stub.inCity).not.toHaveBeenCalled()
    expect(cities.observationSnapshot()).toEqual([])
    expect(stub.observerCount()).toBe(0)
  })

  it('projects a host it can read, once, when a view asks', async () => {
    const stub = stubReader()
    const { source: cities } = source(stub.reader, [target(MEM)])
    const changed = vi.fn()
    cities.observe(changed)
    await settle()
    expect(stub.sessions).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalled()
    const [snapshot] = cities.observationSnapshot()
    expect(snapshot).toMatchObject({ root: MEM, cityRoot: CITY, stale: false })
    expect(snapshot?.sessions.map((fact) => fact.sessionKey)).toEqual(['gc-1'])
  })

  it('costs a workspace with no city nothing but the marker stats', async () => {
    const stub = stubReader({ cities: [] })
    const { source: cities } = source(stub.reader, [target(ELSEWHERE)])
    cities.observe(() => undefined)
    await settle()
    expect(stub.inCity).toHaveBeenCalledTimes(1)
    expect(stub.sessions).not.toHaveBeenCalled()
    expect(stub.context).not.toHaveBeenCalled()
    expect(cities.observationSnapshot()).toEqual([])
  })

  it('tries the other roots on a host whose first project is not in a city', async () => {
    const stub = stubReader({ cities: [MEM.path] })
    const { source: cities } = source(stub.reader, [target(ELSEWHERE), target(MEM)])
    cities.observe(() => undefined)
    await settle()
    expect(stub.inCity).toHaveBeenCalledTimes(2)
    expect(stub.sessions).toHaveBeenCalledTimes(1)
    expect(cities.observationSnapshot()).toHaveLength(1)
  })

  it('reads each host at most once per pass', async () => {
    const remote = hostPath(REMOTE, '/srv/city/rigs/mem')
    const stub = stubReader({ cities: [MEM.path, remote.path] })
    const { source: cities } = source(stub.reader, [
      target(MEM),
      target(hostPath(LOCAL, '/home/dev/city/rigs/polecat')),
      target(remote),
    ])
    cities.observe(() => undefined)
    await settle()
    expect(stub.sessions).toHaveBeenCalledTimes(2)
  })

  it('re-derives when the shared reader announces a newer session list', async () => {
    const stub = stubReader()
    const { source: cities } = source(stub.reader, [target(MEM)])
    cities.observe(() => undefined)
    await settle()
    stub.sessions.mockResolvedValue([session('gc-2', 'mem-worker-2')])
    stub.announce()
    await settle()
    expect(cities.observationSnapshot()[0]?.sessions[0]?.sessionKey).toBe('gc-2')
  })

  it('keeps the last sessions, marked stale, when a read fails', async () => {
    const stub = stubReader()
    const { source: cities } = source(stub.reader, [target(MEM)])
    cities.observe(() => undefined)
    await settle()
    stub.sessions.mockRejectedValue(new Error('gc session list failed'))
    stub.announce()
    await settle()
    const [snapshot] = cities.observationSnapshot()
    expect(snapshot).toMatchObject({ stale: true })
    expect(snapshot?.sessions).toHaveLength(1)
  })

  it('forgets a host that is no longer a candidate', async () => {
    const stub = stubReader()
    const { source: cities, setCandidates } = source(stub.reader, [target(MEM)])
    cities.observe(() => undefined)
    await settle()
    expect(cities.observationSnapshot()).toHaveLength(1)
    setCandidates([])
    await settle()
    expect(cities.observationSnapshot()).toEqual([])
  })

  it('drops every subscription and fact when the last view goes away', async () => {
    const stub = stubReader()
    const { source: cities } = source(stub.reader, [target(MEM)])
    const release = cities.observe(() => undefined)
    await settle()
    expect(stub.observerCount()).toBe(1)
    void release()
    expect(stub.observerCount()).toBe(0)
    expect(cities.observationSnapshot()).toEqual([])
    stub.sessions.mockClear()
    stub.announce()
    await settle()
    expect(stub.sessions).not.toHaveBeenCalled()
  })
})
