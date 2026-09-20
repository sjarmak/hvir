import { describe, expect, it, vi } from 'vitest'

import type { PtyMirrorGeometryEvent } from '../src/main/pty/pty-contract'
import { installMirrorGeometryNotice } from '../src/main/terminal/mirror-geometry-notice'

function world() {
  let listener: ((event: PtyMirrorGeometryEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const owned: { label: string; dispose: () => void | Promise<void> }[] = []
  const toRenderer = vi.fn()
  installMirrorGeometryNotice(
    {
      own: <T>(
        label: string,
        resource: T,
        dispose: (resource: T) => void | Promise<void>,
      ) => {
        owned.push({ label, dispose: () => dispose(resource) })
        return resource
      },
    },
    {
      onMirrorGeometry: (cb) => {
        listener = cb
        return unsubscribe
      },
    },
    { toRenderer },
  )
  if (listener === undefined)
    throw new Error('the notice never subscribed to mirror geometry')
  return { notify: listener, unsubscribe, owned, toRenderer }
}

describe('installMirrorGeometryNotice (ADR-058)', () => {
  it('forwards a hold as the held size and a reclaim as such, to the exact owner', () => {
    const { notify, toRenderer } = world()

    notify({
      kind: 'held',
      id: 'terminal-7',
      ownerId: 31,
      ownerGeneration: 5,
      geometry: { cols: 61, rows: 23 },
    })
    notify({ kind: 'reclaim', id: 'terminal-8', ownerId: 32, ownerGeneration: 6 })

    expect(toRenderer.mock.calls).toEqual([
      [
        { id: 31, generation: 5 },
        'pty:mirror-geometry',
        { id: 'terminal-7', kind: 'held', cols: 61, rows: 23 },
      ],
      [
        { id: 32, generation: 6 },
        'pty:mirror-geometry',
        { id: 'terminal-8', kind: 'reclaim' },
      ],
    ])
    for (const [, , payload] of toRenderer.mock.calls) {
      expect(Object.keys(payload as object)).not.toContain('ownerId')
      expect(Object.keys(payload as object)).not.toContain('ownerGeneration')
    }
  })

  it('disposes with the runtime', async () => {
    const { owned, unsubscribe } = world()

    expect(owned.map((entry) => entry.label)).toEqual(['mirror geometry notice'])
    await owned[0]!.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
