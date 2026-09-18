import { describe, expect, it, vi } from 'vitest'

import type { ManagedPty } from '../src/main/pty/pty-contract'
import { installMirrorInputNotice } from '../src/main/terminal/mirror-input-notice'
import { asHarnessProviderId, asHostId, hostPath } from '../src/shared'

function managed(overrides: Partial<ManagedPty> = {}): ManagedPty {
  const root = hostPath(asHostId('local'), '/repo')
  return {
    instanceId: 'pty-instance-7',
    id: 'terminal-7',
    ownerId: 31,
    ownerGeneration: 5,
    hostId: root.hostId,
    cwd: root,
    workspaceRoot: root,
    providerId: asHarnessProviderId('shell'),
    capabilities: { sessionIdentity: 'none', exactResume: false, contextPresentation: 'none' },
    pid: 4242,
    startedAt: 1,
    resumed: false,
    identityStatus: 'none',
    ...overrides,
  }
}

function world() {
  let listener: ((info: ManagedPty, data: string) => void) | undefined
  const unsubscribe = vi.fn()
  const owned: { label: string; dispose: () => void | Promise<void> }[] = []
  const toRenderer = vi.fn()
  installMirrorInputNotice(
    {
      own: <T>(label: string, resource: T, dispose: (resource: T) => void | Promise<void>) => {
        owned.push({ label, dispose: () => dispose(resource) })
        return resource
      },
    },
    {
      onMirrorInput: (cb) => {
        listener = cb
        return unsubscribe
      },
    },
    { toRenderer },
  )
  if (listener === undefined) throw new Error('the notice never subscribed to mirror input')
  return { notify: listener, unsubscribe, owned, toRenderer }
}

describe('installMirrorInputNotice (ADR-050)', () => {
  it('forwards to the current owner only with id and data', () => {
    const { notify, toRenderer } = world()

    notify(managed(), "printf 'done'\r")
    notify(managed({ ownerId: 32, ownerGeneration: 6, id: 'terminal-8' }), '[A')

    expect(toRenderer.mock.calls).toEqual([
      [{ id: 31, generation: 5 }, 'pty:mirror-input', { id: 'terminal-7', data: "printf 'done'\r" }],
      [{ id: 32, generation: 6 }, 'pty:mirror-input', { id: 'terminal-8', data: '[A' }],
    ])
    for (const [, , payload] of toRenderer.mock.calls) {
      expect(Object.keys(payload as object).sort()).toEqual(['data', 'id'])
    }
  })

  it('disposes with the runtime', async () => {
    const { owned, unsubscribe } = world()

    expect(owned.map((entry) => entry.label)).toEqual(['mirror input notice'])
    await owned[0]!.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
