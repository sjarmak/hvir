import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { runSmokeCleanup, SmokeCleanup } from '../src/main/smoke/cleanup'

describe('SmokeCleanup', () => {
  it('releases each acquired worker when a later worker fails to start', async () => {
    const cleanup = new SmokeCleanup()
    const release = vi.fn<() => void>()
    const failedRelease = vi.fn<() => void>()
    cleanup.acquire(
      'echo worker',
      () => ({ dispose: release }),
      (worker) => worker.dispose(),
    )
    expect(() =>
      cleanup.acquire(
        'Git worker',
        () => {
          throw new Error('worker start failed')
        },
        failedRelease,
      ),
    ).toThrow('worker start failed')
    await cleanup.run()
    expect(release).toHaveBeenCalledOnce()
    expect(failedRelease).not.toHaveBeenCalled()
    const lateCreate = vi.fn<() => void>()
    expect(() => cleanup.acquire('late worker', lateCreate, release)).toThrow(
      'already run',
    )
    expect(lateCreate).not.toHaveBeenCalled()
  })

  it('disposes in reverse order and is idempotent', async () => {
    const order: string[] = []
    const cleanup = new SmokeCleanup()
    cleanup.defer('first', () => {
      order.push('first')
    })
    cleanup.defer('second', async () => {
      await Promise.resolve()
      order.push('second')
    })

    await cleanup.run()
    await cleanup.run()

    expect(order).toEqual(['second', 'first'])
  })

  it('continues cleanup after a disposer fails', async () => {
    const survivor = vi.fn()
    const cleanup = new SmokeCleanup()
    cleanup.defer('survivor', survivor)
    cleanup.defer('failure', () => {
      throw new Error('fixture failure')
    })

    await expect(cleanup.run()).rejects.toThrow('Electron smoke cleanup failed')
    expect(survivor).toHaveBeenCalledOnce()
  })

  it('reports only resources whose disposal completed', async () => {
    const disposed: string[] = []
    const cleanup = new SmokeCleanup((name) => disposed.push(name))
    cleanup.defer('completed', () => undefined)
    cleanup.defer('failed', () => {
      throw new Error('fixture failure')
    })

    await expect(cleanup.run()).rejects.toThrow('Electron smoke cleanup failed')
    expect(disposed).toEqual(['completed'])
  })

  it('bounds a stalled disposer and continues through remaining cleanup', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const survivor = vi.fn()
    const failed: string[] = []
    const cleanup = new SmokeCleanup(undefined, {
      taskTimeoutMs: 25,
      onFailure: (name) => failed.push(name),
    })
    cleanup.defer('survivor', survivor)
    cleanup.defer('stalled', () => new Promise<void>(() => undefined))
    const result = cleanup.run()
    const failure = expect(result).rejects.toThrow('Electron smoke cleanup failed')

    await vi.advanceTimersByTimeAsync(25)

    await failure
    expect(failed).toEqual(['stalled'])
    expect(survivor).toHaveBeenCalledOnce()
  })

  it('completes the smoke cleanup policy when cleanup succeeds', async () => {
    const cleanup = new SmokeCleanup()
    const onFailure = vi.fn()

    await runSmokeCleanup(cleanup, false, onFailure)

    expect(onFailure).not.toHaveBeenCalled()
  })

  it('preserves a failed scenario result when cleanup also fails', async () => {
    const cleanup = new SmokeCleanup()
    cleanup.defer('failure', () => {
      throw new Error('cleanup failure')
    })
    const onFailure = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    onTestFinished(() => consoleError.mockRestore())

    await runSmokeCleanup(cleanup, true, onFailure)

    expect(onFailure).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('fails a successful scenario when cleanup rejects', async () => {
    const cleanup = new SmokeCleanup()
    cleanup.defer('failure', () => {
      throw new Error('cleanup failure')
    })
    const onFailure = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    onTestFinished(() => consoleError.mockRestore())

    await expect(runSmokeCleanup(cleanup, false, onFailure)).rejects.toThrow(
      'Electron smoke cleanup failed',
    )
    expect(onFailure).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledOnce()
  })
})
