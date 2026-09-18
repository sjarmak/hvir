import { describe, expect, it, vi } from 'vitest'

import { ownGasCityRuntime } from '../src/main/gascity/gascity-owner'
import type { ProjectState } from '../src/shared'

function harness() {
  const owned: { label: string; dispose: () => void | Promise<void> }[] = []
  const runtime = {
    own: <T>(
      label: string,
      resource: T,
      dispose: (resource: T) => void | Promise<void>,
    ) => {
      owned.push({ label, dispose: () => dispose(resource) })
      return resource
    },
  }
  const state = { projects: [] } as unknown as ProjectState
  const deps = {
    projects: { state: () => state, observe: () => () => undefined },
    hosts: { connectedHosts: () => [], onHostStateChange: () => () => undefined },
  }
  const publish = vi.fn()
  return { runtime, deps, publish, owned }
}

describe('ownGasCityRuntime', () => {
  it('owns the streams and the rollup on the runtime and hands back every part', async () => {
    const world = harness()
    const gasCity = ownGasCityRuntime(world.runtime, world.deps, world.publish)

    expect(world.owned.map((entry) => entry.label)).toEqual([
      'Gas City event streams',
      'Gas City attention rollup',
    ])
    expect(gasCity.attention.snapshot().entries).toEqual([])
    expect(gasCity.streams.observationSnapshot()).toEqual([])
    expect(gasCity.reader).toBeDefined()
    expect(gasCity.supervisor).toBeDefined()
    expect(gasCity.sessionsSource).toBeDefined()

    for (const entry of world.owned.reverse()) await entry.dispose()
  })
})
