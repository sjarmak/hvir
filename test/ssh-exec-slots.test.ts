import { describe, expect, it } from 'vitest'

import {
  ExecSlots,
  SSH_DEFAULT_MAX_CONCURRENT_EXECS,
  SSH_MAX_BACKGROUND_EXECS,
} from '../src/main/project-host'

function slots(maxConcurrent?: number, disposed = (): boolean => false): ExecSlots {
  return new ExecSlots({
    disposed,
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
  })
}

/** Whether a pending acquire has been admitted, without awaiting it. */
function admitted(pending: Promise<() => void>): Promise<boolean> {
  return Promise.race([
    pending.then(() => true),
    Promise.resolve().then(() => false),
  ])
}

describe('ExecSlots', () => {
  it('admits interactive work up to the whole budget', async () => {
    const budget = slots(3)
    const held = [
      await budget.acquire('interactive'),
      await budget.acquire('interactive'),
      await budget.acquire('interactive'),
    ]
    const queued = budget.acquire('interactive')
    await expect(admitted(queued)).resolves.toBe(false)

    held[0]?.()
    await expect(queued).resolves.toBeInstanceOf(Function)
    for (const release of held.slice(1)) release?.()
  })

  it('holds background work to one slot while the budget has room', async () => {
    const budget = slots(4)
    const poll = await budget.acquire('background')
    const secondPoll = budget.acquire('background')
    await expect(admitted(secondPoll)).resolves.toBe(false)

    // Three interactive slots are still free, so a user-facing command runs
    // even though a background exec is already queued ahead of it.
    await expect(budget.acquire('interactive')).resolves.toBeInstanceOf(Function)

    poll()
    await expect(secondPoll).resolves.toBeInstanceOf(Function)
  })

  it('passes over a queued background exec to admit interactive work', async () => {
    const budget = slots(2)
    const poll = await budget.acquire('background')
    const interactive = await budget.acquire('interactive')
    const queuedPoll = budget.acquire('background')
    const queuedInteractive = budget.acquire('interactive')

    // The freed slot cannot go to the queued poll — the background lane is still
    // occupied — so it goes to the interactive command queued behind it.
    interactive()
    await expect(queuedInteractive).resolves.toBeInstanceOf(Function)
    await expect(admitted(queuedPoll)).resolves.toBe(false)

    poll()
    await expect(queuedPoll).resolves.toBeInstanceOf(Function)
  })

  it('clamps a nonsensical budget to at least one slot', async () => {
    await expect(slots(0).acquire('interactive')).resolves.toBeInstanceOf(Function)
    await expect(slots(Number.NaN).acquire('interactive')).resolves.toBeInstanceOf(
      Function,
    )
  })

  it('refuses to queue once the host is disposed', async () => {
    const budget = slots(1, () => true)
    await expect(budget.acquire('interactive')).rejects.toThrow(/disconnected/)
  })

  it('rejects a waiter whose signal aborts', async () => {
    const budget = slots(1)
    const held = await budget.acquire('interactive')
    const controller = new AbortController()
    const queued = budget.acquire('interactive', controller.signal)
    controller.abort()
    await expect(queued).rejects.toThrow(/aborted/)
    held()
  })

  it('rejects everything queued when the host cancels', async () => {
    const budget = slots(1)
    const held = await budget.acquire('interactive')
    const queued = budget.acquire('interactive')
    budget.cancelAll(new Error('SSH connection cancelled'))
    await expect(queued).rejects.toThrow(/cancelled/)
    held()
  })

  it('reserves at least one slot for interactive work at the default budget', () => {
    expect(SSH_MAX_BACKGROUND_EXECS).toBeLessThan(SSH_DEFAULT_MAX_CONCURRENT_EXECS)
  })
})
