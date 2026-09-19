import { describe, expect, it, vi } from 'vitest'

import {
  PtyMirrorRefusedError,
  createPtyMirrorLease,
  mirrorRefusal,
  type PtyMirrorEntryView,
  type PtyMirrorLeaseState,
} from '../src/main/pty/pty-mirror-lease'
import type { PtyMirrorHandlers } from '../src/main/pty/pty-contract'

const INSTANCE = 'instance-a'

function view(overrides: Partial<PtyMirrorEntryView> = {}): PtyMirrorEntryView {
  return {
    current: true,
    instanceId: INSTANCE,
    write: () => undefined,
    resize: () => undefined,
    ...overrides,
  }
}

describe('mirrorRefusal', () => {
  it.each<{
    readonly name: string
    readonly state: PtyMirrorLeaseState
    readonly current: PtyMirrorEntryView | undefined
    readonly refusal: string | undefined
  }>([
    {
      name: 'a live lease on its current entry',
      state: 'live',
      current: view(),
      refusal: undefined,
    },
    { name: 'a released lease', state: 'released', current: view(), refusal: 'ended' },
    {
      name: 'a released lease even when the instance changed',
      state: 'released',
      current: view({ instanceId: 'instance-b' }),
      refusal: 'ended',
    },
    {
      name: 'another live instance under the same id',
      state: 'live',
      current: view({ instanceId: 'instance-b' }),
      refusal: 'instance-changed',
    },
    {
      name: 'another instance after the lease ended',
      state: 'ended',
      current: view({ instanceId: 'instance-b' }),
      refusal: 'instance-changed',
    },
    {
      name: 'an ended lease with no entry',
      state: 'ended',
      current: undefined,
      refusal: 'exited',
    },
    {
      name: 'an ended lease on a current entry',
      state: 'ended',
      current: view(),
      refusal: 'exited',
    },
    {
      name: 'a live lease with no entry',
      state: 'live',
      current: undefined,
      refusal: 'exited',
    },
    {
      name: 'a live lease on a terminated entry',
      state: 'live',
      current: view({ current: false }),
      refusal: 'exited',
    },
  ])('decides $name', ({ state, current, refusal }) => {
    expect(mirrorRefusal(state, current, INSTANCE)).toBe(refusal)
  })
})

describe('createPtyMirrorLease', () => {
  function world(entry: () => PtyMirrorEntryView | undefined) {
    let attached: PtyMirrorHandlers | undefined
    const detach = vi.fn()
    const onInput = vi.fn<(data: string) => void>()
    const handlers: PtyMirrorHandlers = {
      onData: vi.fn(),
      onGeometry: vi.fn(),
      onEnd: vi.fn(),
    }
    const lease = createPtyMirrorLease(
      {
        ptyId: 'pty-1',
        instanceId: INSTANCE,
        entry,
        attach: (mirror) => {
          attached = mirror
          return detach
        },
        retained: () => ({ preamble: 'sticky', tail: 'retained' }),
        geometry: () => ({ cols: 100, rows: 30 }),
        onInput,
      },
      handlers,
    )
    return { lease, handlers, detach, onInput, stream: () => attached! }
  }

  it('exposes the tail, its preamble and geometry at attach and forwards live data', () => {
    const { lease, handlers, stream } = world(() => view())
    expect(lease).toMatchObject({
      ptyId: 'pty-1',
      instanceId: INSTANCE,
      tail: 'retained',
      preamble: 'sticky',
      geometry: { cols: 100, rows: 30 },
      ended: false,
    })
    stream().onData('live')
    stream().onGeometry({ cols: 120, rows: 40 })
    expect(handlers.onData).toHaveBeenCalledExactlyOnceWith('live')
    expect(handlers.onGeometry).toHaveBeenCalledExactlyOnceWith({ cols: 120, rows: 40 })
  })

  it('writes through the current entry and fans the input out', () => {
    const write = vi.fn<(data: string) => void>()
    const { lease, onInput } = world(() => view({ write }))
    lease.write('[A')
    expect(write).toHaveBeenCalledExactlyOnceWith('[A')
    expect(onInput).toHaveBeenCalledExactlyOnceWith('[A')
  })

  it('refuses a write with the reason and the pty id only, writing nothing', () => {
    const write = vi.fn<(data: string) => void>()
    const { lease, onInput } = world(() => view({ write, instanceId: 'instance-b' }))
    let refused: unknown
    try {
      lease.write('secret-bytes')
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(PtyMirrorRefusedError)
    const error = refused as PtyMirrorRefusedError
    expect(error.reason).toBe('instance-changed')
    expect(error.ptyId).toBe('pty-1')
    expect(error.message).not.toContain('secret-bytes')
    expect(write).not.toHaveBeenCalled()
    expect(onInput).not.toHaveBeenCalled()
  })

  it('resizes through the current entry with the exact dimensions and fans no input out', () => {
    const resize = vi.fn<(cols: number, rows: number) => void>()
    const { lease, onInput } = world(() => view({ resize }))
    lease.resize(52, 38)
    expect(resize).toHaveBeenCalledExactlyOnceWith(52, 38)
    expect(onInput).not.toHaveBeenCalled()
  })

  it('refuses a resize under the same lease and instance rules as a write', () => {
    const resize = vi.fn<(cols: number, rows: number) => void>()
    const { lease } = world(() => view({ resize, instanceId: 'instance-b' }))
    expect(() => lease.resize(52, 38)).toThrow(
      expect.objectContaining({
        reason: 'instance-changed',
        ptyId: 'pty-1',
      }) as PtyMirrorRefusedError,
    )
    expect(resize).not.toHaveBeenCalled()
  })

  it('lets the entry refuse a resize as desktop-focused', () => {
    const { lease } = world(() =>
      view({
        resize: () => {
          throw new PtyMirrorRefusedError('desktop-focused', 'pty-1')
        },
      }),
    )
    expect(() => lease.resize(52, 38)).toThrow(
      expect.objectContaining({ reason: 'desktop-focused' }) as PtyMirrorRefusedError,
    )
  })

  it('release detaches once, ends the lease and refuses later writes and resizes as ended', () => {
    const write = vi.fn<(data: string) => void>()
    const resize = vi.fn<(cols: number, rows: number) => void>()
    const { lease, handlers, detach, stream } = world(() => view({ write, resize }))
    lease.release()
    lease.release()
    expect(detach).toHaveBeenCalledOnce()
    expect(lease.ended).toBe(true)
    expect(handlers.onEnd).not.toHaveBeenCalled()
    expect(() => lease.write('x')).toThrow(
      expect.objectContaining({ reason: 'ended' }) as PtyMirrorRefusedError,
    )
    expect(() => lease.resize(52, 38)).toThrow(
      expect.objectContaining({ reason: 'ended' }) as PtyMirrorRefusedError,
    )
    expect(write).not.toHaveBeenCalled()
    expect(resize).not.toHaveBeenCalled()
    stream().onData('after release')
    expect(handlers.onData).not.toHaveBeenCalled()
  })

  it('delivers onEnd exactly once and nothing after it', () => {
    const { lease, handlers, stream } = world(() => undefined)
    stream().onEnd({ kind: 'released' })
    stream().onEnd({ kind: 'released' })
    stream().onData('late')
    stream().onGeometry({ cols: 1, rows: 1 })
    expect(handlers.onEnd).toHaveBeenCalledExactlyOnceWith({ kind: 'released' })
    expect(handlers.onData).not.toHaveBeenCalled()
    expect(handlers.onGeometry).not.toHaveBeenCalled()
    expect(lease.ended).toBe(true)
    expect(() => lease.write('x')).toThrow(
      expect.objectContaining({ reason: 'exited' }) as PtyMirrorRefusedError,
    )
    expect(() => lease.resize(52, 38)).toThrow(
      expect.objectContaining({ reason: 'exited' }) as PtyMirrorRefusedError,
    )
  })
})
