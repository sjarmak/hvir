import { describe, expect, it, vi, type Mock } from 'vitest'

import { PTY_OUTPUT_TAIL_CHARS } from '../src/main/pty/pty-output-tail'
import { PtyMirrorRefusedError } from '../src/main/pty/pty-mirror-lease'
import type { PtyMirrorHandlers } from '../src/main/pty/pty-supervisor'
import {
  createPtySupervisorFixture,
  plainShellProvider,
  PTY_FIXTURE_OWNER_ID,
  TestPtyProcess,
} from './fixtures/pty-supervisor-fixture'

const OWNER_ID = PTY_FIXTURE_OWNER_ID
const SESSION_ID = 'mirrored-session'

async function fixture(overrides: { cols?: number; rows?: number } = {}) {
  const ptyFixture = createPtySupervisorFixture({ provider: plainShellProvider })
  const info = await ptyFixture.spawn({
    provider: plainShellProvider,
    ownerId: OWNER_ID,
    ownerGeneration: 4,
    sessionId: SESSION_ID,
    ...overrides,
  })
  return { info, pty: ptyFixture.pty, supervisor: ptyFixture.supervisor, ptyFixture }
}

interface MockedMirrorHandlers extends PtyMirrorHandlers {
  readonly onData: Mock<PtyMirrorHandlers['onData']>
  readonly onGeometry: Mock<PtyMirrorHandlers['onGeometry']>
  readonly onEnd: Mock<PtyMirrorHandlers['onEnd']>
}

function handlers(): MockedMirrorHandlers {
  return {
    onData: vi.fn<PtyMirrorHandlers['onData']>(),
    onGeometry: vi.fn<PtyMirrorHandlers['onGeometry']>(),
    onEnd: vi.fn<PtyMirrorHandlers['onEnd']>(),
  }
}

function refusal(action: () => void): string | undefined {
  try {
    action()
  } catch (error) {
    if (error instanceof PtyMirrorRefusedError) return error.reason
    throw error
  }
  return undefined
}

describe('PtySupervisor mirror lease', () => {
  it('a mirror attached after the renderer receives the retained tail then live bytes', async () => {
    const { info, pty, supervisor } = await fixture()
    const renderer = vi.fn<(data: string) => void>()
    pty.emitData('first')
    supervisor.attach(info.id, OWNER_ID, { onData: renderer }, 4)
    pty.emitData(' second')

    const mirror = handlers()
    const lease = supervisor.attachMirror(info.id, info.instanceId, mirror)
    expect(lease.tail).toBe('first second')
    expect(lease.ptyId).toBe(info.id)
    expect(lease.instanceId).toBe(info.instanceId)

    pty.emitData(' third')
    expect(mirror.onData.mock.calls.map(([data]) => data)).toEqual([' third'])
    expect(renderer.mock.calls.map(([data]) => data)).toEqual([
      'first',
      ' second',
      ' third',
    ])
  })

  it('the mirror tail is bounded at 256K characters independent of replay', async () => {
    const { info, pty, supervisor } = await fixture()
    supervisor.attach(info.id, OWNER_ID, { onData: () => undefined }, 4)
    pty.emitData('abc')
    pty.emitData(`discard${'x'.repeat(PTY_OUTPUT_TAIL_CHARS)}`)
    pty.emitData('tail')

    const lease = supervisor.attachMirror(info.id, info.instanceId, handlers())
    expect(lease.tail.length).toBe(PTY_OUTPUT_TAIL_CHARS)
    expect(lease.tail).toBe(`${'x'.repeat(PTY_OUTPUT_TAIL_CHARS - 4)}tail`)
  })

  it('a second mirror still receives the full tail after the first attached', async () => {
    const { info, pty, supervisor } = await fixture()
    pty.emitData('before')
    supervisor.attachMirror(info.id, info.instanceId, handlers())
    pty.emitData(' after')
    const second = supervisor.attachMirror(info.id, info.instanceId, handlers())
    expect(second.tail).toBe('before after')
  })

  it('a mirror does not count as a renderer attachment', async () => {
    const { info, pty, supervisor } = await fixture()
    const mirror = handlers()
    supervisor.attachMirror(info.id, info.instanceId, mirror)
    pty.emitData('unattached output')

    expect(supervisor.transferRendererSession(info.id, OWNER_ID, 4, OWNER_ID, 5)).toBe(
      false,
    )
    expect(supervisor.isAwaitingRendererAttachment(info.id, OWNER_ID, 4)).toBe(false)

    const renderer = vi.fn<(data: string) => void>()
    supervisor.attach(info.id, OWNER_ID, { onData: renderer }, 4)
    expect(renderer).toHaveBeenCalledExactlyOnceWith('unattached output')
    expect(mirror.onData).toHaveBeenCalledExactlyOnceWith('unattached output')
  })

  it('a mirror survives a renderer document transfer', async () => {
    const { info, pty, supervisor } = await fixture()
    supervisor.attach(info.id, OWNER_ID, { onData: () => undefined }, 4)
    const mirror = handlers()
    const lease = supervisor.attachMirror(info.id, info.instanceId, mirror)

    expect(supervisor.transferRendererSession(info.id, OWNER_ID, 4, OWNER_ID, 5)).toBe(
      true,
    )
    pty.emitData('during rollover')
    expect(mirror.onData).toHaveBeenCalledExactlyOnceWith('during rollover')
    expect(mirror.onEnd).not.toHaveBeenCalled()

    lease.write('from the phone')
    expect(pty.write).toHaveBeenCalledExactlyOnceWith('from the phone')

    const renderer = vi.fn<(data: string) => void>()
    supervisor.attach(info.id, OWNER_ID, { onData: renderer }, 5)
    expect(renderer).toHaveBeenCalledExactlyOnceWith('during rollover')
    pty.emitData('after reattach')
    expect(mirror.onData).toHaveBeenLastCalledWith('after reattach')
  })

  it('a mirror ends with exited on PTY exit and write then throws exited', async () => {
    const { info, pty, supervisor } = await fixture()
    const mirror = handlers()
    const lease = supervisor.attachMirror(info.id, info.instanceId, mirror)

    pty.emitExit({ exitCode: 3, signal: undefined })
    expect(mirror.onEnd).toHaveBeenCalledExactlyOnceWith({
      kind: 'exited',
      exit: { exitCode: 3, signal: undefined },
    })
    expect(lease.ended).toBe(true)
    expect(supervisor.get(info.id)).toBeUndefined()
    expect(refusal(() => lease.write('late'))).toBe('exited')
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('a mirror ends with released on disposeSession', async () => {
    const { info, pty, supervisor } = await fixture()
    const mirror = handlers()
    const lease = supervisor.attachMirror(info.id, info.instanceId, mirror)

    supervisor.disposeSession(info.id, OWNER_ID, 4)
    expect(mirror.onEnd).toHaveBeenCalledExactlyOnceWith({ kind: 'released' })
    expect(lease.ended).toBe(true)
    expect(refusal(() => lease.write('late'))).toBe('exited')
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('a mirror ends with released on disposeAll', async () => {
    const { info, pty, supervisor } = await fixture()
    const mirror = handlers()
    const lease = supervisor.attachMirror(info.id, info.instanceId, mirror)

    supervisor.disposeAll()
    expect(mirror.onEnd).toHaveBeenCalledExactlyOnceWith({ kind: 'released' })
    expect(refusal(() => lease.write('late'))).toBe('exited')
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('write through a released lease throws ended and writes nothing', async () => {
    const { info, pty, supervisor } = await fixture()
    const mirror = handlers()
    const lease = supervisor.attachMirror(info.id, info.instanceId, mirror)

    lease.release()
    lease.release()
    expect(lease.ended).toBe(true)
    expect(refusal(() => lease.write('released'))).toBe('ended')
    expect(pty.write).not.toHaveBeenCalled()
    expect(pty.kill).not.toHaveBeenCalled()
    expect(pty.resize).not.toHaveBeenCalled()

    pty.emitData('after release')
    expect(mirror.onData).not.toHaveBeenCalled()
    pty.emitExit({ exitCode: 0, signal: undefined })
    expect(mirror.onEnd).not.toHaveBeenCalled()
  })

  it('a mirror may release itself from inside its own onData', async () => {
    const { info, pty, supervisor } = await fixture()
    const other = handlers()
    const self = handlers()
    const lease = supervisor.attachMirror(info.id, info.instanceId, {
      ...self,
      onData: (data) => {
        self.onData(data)
        lease.release()
      },
    })
    supervisor.attachMirror(info.id, info.instanceId, other)

    pty.emitData('once')
    pty.emitData('twice')
    expect(self.onData).toHaveBeenCalledExactlyOnceWith('once')
    expect(other.onData.mock.calls.map(([data]) => data)).toEqual(['once', 'twice'])
  })

  it('write after exit and respawn under the same id throws instance-changed and the new process is never written', async () => {
    const { info, pty, supervisor, ptyFixture } = await fixture()
    const lease = supervisor.attachMirror(info.id, info.instanceId, handlers())
    pty.emitExit({ exitCode: 0, signal: undefined })

    const respawn = new TestPtyProcess()
    const deferred = ptyFixture.deferNextSpawn(respawn)
    const spawning = ptyFixture.spawn({
      provider: plainShellProvider,
      ownerId: OWNER_ID,
      ownerGeneration: 4,
      sessionId: SESSION_ID,
    })
    deferred.resolve()
    const next = await spawning
    expect(next.id).toBe(info.id)
    expect(next.instanceId).not.toBe(info.instanceId)

    expect(refusal(() => lease.write('stale'))).toBe('instance-changed')
    expect(respawn.write).not.toHaveBeenCalled()
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('geometry defaults to 80x24 when spawn carries none and follows renderer resize; the lease has no resize', async () => {
    const { info, pty, supervisor } = await fixture()
    const mirror = handlers()
    const lease = supervisor.attachMirror(info.id, info.instanceId, mirror)
    expect(lease.geometry).toEqual({ cols: 80, rows: 24 })
    expect('resize' in lease).toBe(false)
    expect('kill' in lease).toBe(false)

    supervisor.resize(info.id, OWNER_ID, 120, 40, 4)
    expect(pty.resize).toHaveBeenCalledExactlyOnceWith(120, 40)
    expect(mirror.onGeometry).toHaveBeenCalledExactlyOnceWith({ cols: 120, rows: 40 })

    const late = supervisor.attachMirror(info.id, info.instanceId, handlers())
    expect(late.geometry).toEqual({ cols: 120, rows: 40 })
  })

  it('a resize the PTY refuses leaves the mirror geometry at the last applied size and publishes nothing', async () => {
    const { info, pty, supervisor } = await fixture({ cols: 100, rows: 30 })
    const mirror = handlers()
    supervisor.attachMirror(info.id, info.instanceId, mirror)
    pty.resize.mockImplementationOnce(() => {
      throw new Error('Cannot resize a pty that has already exited')
    })

    expect(() => supervisor.resize(info.id, OWNER_ID, 120, 40, 4)).toThrow(
      'Cannot resize a pty that has already exited',
    )
    expect(pty.resize).toHaveBeenCalledExactlyOnceWith(120, 40)
    expect(mirror.onGeometry).not.toHaveBeenCalled()
    const late = supervisor.attachMirror(info.id, info.instanceId, handlers())
    expect(late.geometry).toEqual({ cols: 100, rows: 30 })

    supervisor.resize(info.id, OWNER_ID, 120, 40, 4)
    expect(mirror.onGeometry).toHaveBeenCalledExactlyOnceWith({ cols: 120, rows: 40 })
    expect(
      supervisor.attachMirror(info.id, info.instanceId, handlers()).geometry,
    ).toEqual({
      cols: 120,
      rows: 40,
    })
  })

  it('geometry starts from the spawn request when it carries one', async () => {
    const { info, supervisor } = await fixture({ cols: 100, rows: 30 })
    const lease = supervisor.attachMirror(info.id, info.instanceId, handlers())
    expect(lease.geometry).toEqual({ cols: 100, rows: 30 })
  })

  it('mirror writes pass through uncomposed', async () => {
    const { info, pty, supervisor } = await fixture()
    const lease = supervisor.attachMirror(info.id, info.instanceId, handlers())
    lease.write('[A')
    lease.write('\udc00')
    lease.write('\r')
    expect(pty.write.mock.calls).toEqual([['[A'], ['\udc00'], ['\r']])
    expect(pty.writeConfirmed).not.toHaveBeenCalled()
  })

  it('mirror input fans out to onMirrorInput with the current owner and never to diagnostics', async () => {
    const { info, pty, supervisor, ptyFixture } = await fixture()
    const seen =
      vi.fn<(info: { ownerGeneration: number; id: string }, data: string) => void>()
    const stop = supervisor.onMirrorInput((current, data) =>
      seen({ ownerGeneration: current.ownerGeneration, id: current.id }, data),
    )
    supervisor.attach(info.id, OWNER_ID, { onData: () => undefined }, 4)
    const lease = supervisor.attachMirror(info.id, info.instanceId, handlers())
    expect(supervisor.transferRendererSession(info.id, OWNER_ID, 4, OWNER_ID, 5)).toBe(
      true,
    )

    lease.write('mirror-secret-bytes')
    expect(seen).toHaveBeenCalledExactlyOnceWith(
      { ownerGeneration: 5, id: info.id },
      'mirror-secret-bytes',
    )
    expect(JSON.stringify(ptyFixture.snapshot())).not.toContain('mirror-secret')

    void stop()
    lease.write('after unsubscribe')
    expect(seen).toHaveBeenCalledOnce()
    expect(pty.write).toHaveBeenCalledTimes(2)
  })

  it('a refused write never reaches onMirrorInput', async () => {
    const { info, supervisor } = await fixture()
    const seen = vi.fn()
    supervisor.onMirrorInput(seen)
    const lease = supervisor.attachMirror(info.id, info.instanceId, handlers())
    lease.release()
    expect(refusal(() => lease.write('dropped'))).toBe('ended')
    expect(seen).not.toHaveBeenCalled()
  })

  it('attachMirror on an unknown session or wrong instance throws PtyMirrorRefusedError', async () => {
    const { info, supervisor } = await fixture()
    expect(
      refusal(() => supervisor.attachMirror('unknown', info.instanceId, handlers())),
    ).toBe('no-session')
    expect(
      refusal(() => supervisor.attachMirror(info.id, 'other-instance', handlers())),
    ).toBe('instance-changed')
  })

  it('attachMirror on a terminated entry throws exited before the entry is dropped', async () => {
    const { info, supervisor } = await fixture()
    const exitedDuringDisposal = vi.fn<(reason: string | undefined) => void>()
    supervisor.attachMirror(info.id, info.instanceId, {
      ...handlers(),
      onEnd: () => {
        exitedDuringDisposal(
          refusal(() => supervisor.attachMirror(info.id, info.instanceId, handlers())),
        )
      },
    })
    supervisor.disposeSession(info.id, OWNER_ID, 4)
    expect(exitedDuringDisposal).toHaveBeenCalledExactlyOnceWith('exited')
  })

  it('renderer replay keeps its bound and drains once while the tail stays', async () => {
    const { info, pty, supervisor } = await fixture()
    pty.emitData(`discard${'x'.repeat(PTY_OUTPUT_TAIL_CHARS)}`)
    const renderer = vi.fn<(data: string) => void>()
    supervisor.attach(info.id, OWNER_ID, { onData: renderer }, 4)
    expect(renderer).toHaveBeenCalledExactlyOnceWith('x'.repeat(PTY_OUTPUT_TAIL_CHARS))
    const again = vi.fn<(data: string) => void>()
    supervisor.attach(info.id, OWNER_ID, { onData: again }, 4)
    expect(again).not.toHaveBeenCalled()
    const lease = supervisor.attachMirror(info.id, info.instanceId, handlers())
    expect(lease.tail).toBe('x'.repeat(PTY_OUTPUT_TAIL_CHARS))
  })
})
