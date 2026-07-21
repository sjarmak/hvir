import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalHost } from '../src/main/project-host/local-host'
import {
  ExecTimeoutError,
  isExecTimeout,
} from '../src/main/project-host/exec-timeout'
import { localPath } from '../src/shared'

/**
 * A buffered exec that never returns is not a hypothetical: a `gc` that prompts
 * on stdin, or an `ssh` whose transport wedges, holds its lane slot forever and
 * silently freezes every poll behind it. The timeout is the trust boundary that
 * turns that into a real, propagated error.
 */
describe('exec timeout', () => {
  it('rejects with ExecTimeoutError when the command outlives its budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hvir-exec-timeout-'))
    const host = new LocalHost()
    await host.connect()
    try {
      const started = Date.now()
      const failure = await host
        .exec('sleep', ['30'], { cwd: localPath(dir), timeout: 150 })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        )
      expect(failure).toBeInstanceOf(ExecTimeoutError)
      expect(isExecTimeout(failure)).toBe(true)
      expect((failure as ExecTimeoutError).timeoutMs).toBe(150)
      // The point of the budget is that it is enforced, not merely recorded.
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await host.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves a command that finishes inside its budget untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hvir-exec-timeout-'))
    const host = new LocalHost()
    await host.connect()
    try {
      const result = await host.exec('printf', ['crew'], {
        cwd: localPath(dir),
        timeout: 10_000,
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('crew')
    } finally {
      await host.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports an explicit abort as a cancellation, not a timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hvir-exec-timeout-'))
    const host = new LocalHost()
    await host.connect()
    const controller = new AbortController()
    try {
      const pending = host
        .exec('sleep', ['30'], {
          cwd: localPath(dir),
          timeout: 10_000,
          signal: controller.signal,
        })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        )
      controller.abort()
      const failure = await pending
      expect(failure).toBeDefined()
      expect(isExecTimeout(failure)).toBe(false)
    } finally {
      await host.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not arm a timer when no timeout is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hvir-exec-timeout-'))
    const host = new LocalHost()
    await host.connect()
    try {
      const result = await host.exec('printf', ['ok'], { cwd: localPath(dir) })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('ok')
    } finally {
      await host.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
