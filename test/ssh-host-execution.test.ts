import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { SSH_DEFAULT_MAX_CONCURRENT_EXECS } from '../src/main/project-host'
import { createTestSshHost } from './ssh-host-test-fixture'

describe('SshHost execution behavior', () => {
  it('supports bounded duplex exec streams over SSH', async () => {
    const stderr = new EventEmitter()
    const channel = Object.assign(new EventEmitter(), {
      stderr,
      close: vi.fn(() => channel.emit('close')),
      write: vi.fn((data: string, callback?: () => void) => {
        channel.emit('data', Buffer.from(data))
        callback?.()
        return true
      }),
      end: vi.fn((data?: string, callback?: () => void) => {
        if (data) channel.emit('data', Buffer.from(data))
        callback?.()
        queueMicrotask(() => {
          channel.emit('exit', 0)
          channel.emit('close')
        })
      }),
    })
    const client = Object.assign(
      fakeClient(() => undefined),
      {
        exec: vi.fn(
          (
            _command: string,
            callback: (error: Error | undefined, value: unknown) => void,
          ) => callback(undefined, channel),
        ),
      },
    )
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as { state: 'connected'; client: Client }
    internals.state = 'connected'
    internals.client = client as unknown as Client
    const stream = host.execStream('cat', [], { keepStdinOpen: true })
    let stdout = ''
    stream.onStdout((chunk) => {
      stdout += chunk
    })
    const exited = new Promise<void>((resolve, reject) => {
      stream.onError(reject)
      stream.onExit(() => resolve())
    })

    await stream.write('first ')
    await stream.end('second')
    await exited

    expect(stdout).toBe('first second')
    expect(channel.write).toHaveBeenCalledWith('first ', expect.any(Function))
    await host.dispose()
  })

  it('keeps buffered execs within the SSH session budget', async () => {
    const { host, client, channels } = execBudgetFixture(3, 2)
    const results = [host.exec('one', []), host.exec('two', []), host.exec('three', [])]
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(2))
    settleExec(channels[0])
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(3))
    settleExec(channels[1])
    settleExec(channels[2])

    await expect(Promise.all(results)).resolves.toHaveLength(3)
    await host.dispose()
  })

  it('admits bounded parallel buffered execs by default', async () => {
    const { host, client, channels } = execBudgetFixture(
      SSH_DEFAULT_MAX_CONCURRENT_EXECS + 1,
    )

    const results = channels.map((_, index) => host.exec(`command-${index}`, []))
    await vi.waitFor(() =>
      expect(client.exec).toHaveBeenCalledTimes(SSH_DEFAULT_MAX_CONCURRENT_EXECS),
    )
    settleExec(channels[0])
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(channels.length))
    for (const channel of channels.slice(1)) settleExec(channel)

    await expect(Promise.all(results)).resolves.toHaveLength(channels.length)
    await host.dispose()
  })

  it('routes a background exec into the reserved lane, not the whole budget', async () => {
    const { host, client, channels } = execBudgetFixture(3, 4)

    const results = [
      host.exec('poll-one', [], { lane: 'background' }),
      host.exec('poll-two', [], { lane: 'background' }),
      host.exec('status-check', []),
    ]
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(2))
    const started = client.exec.mock.calls.map((call) => String(call[0]))
    expect(started.map((command) => command.includes('poll'))).toEqual([true, false])

    settleExec(channels[0])
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(3))
    for (const channel of channels.slice(1)) settleExec(channel)

    await expect(Promise.all(results)).resolves.toHaveLength(3)
    await host.dispose()
  })

  it('reports a budget spent waiting for the background lane as a timeout', async () => {
    vi.useFakeTimers()
    try {
      const { host, client, channels } = execBudgetFixture(3, 4)
      const running = host.exec('poll-one', [], { lane: 'background' })
      await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(1))
      const queued = host.exec('poll-two', [], { lane: 'background', timeout: 50 })
      const rejected = expect(queued).rejects.toThrow(
        'poll-two exceeded its 50ms timeout',
      )
      await vi.advanceTimersByTimeAsync(60)
      await rejected
      settleExec(channels[0])
      await expect(running).resolves.toMatchObject({ code: 0 })
      await host.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transient SSH channel-open race', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      close: vi.fn(),
      end: vi.fn(),
    })
    const client = Object.assign(
      fakeClient(() => undefined),
      {
        exec: vi
          .fn(
            (
              _command: string,
              callback: (error: Error | undefined, value?: unknown) => void,
            ) => callback(undefined, channel),
          )
          .mockImplementationOnce((_command, callback) =>
            callback(new Error('(SSH) Channel open failure: open failed')),
          ),
      },
    )
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = host as unknown as { state: 'connected'; client: Client }
    internals.state = 'connected'
    internals.client = client as unknown as Client

    const result = host.exec('git', ['status'])
    await vi.waitFor(() => expect(client.exec).toHaveBeenCalledTimes(2))
    channel.emit('exit', 0)
    channel.emit('close')

    await expect(result).resolves.toMatchObject({ code: 0 })
    await host.dispose()
  })

  it('resolves and caches the remote host shell', async () => {
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const exec = vi
      .spyOn(host, 'exec')
      .mockResolvedValue({ code: 0, signal: null, stdout: '/bin/bash\n', stderr: '' })

    await expect(host.defaultShell()).resolves.toBe('/bin/bash')
    await expect(host.defaultShell()).resolves.toBe('/bin/bash')
    expect(exec).toHaveBeenCalledOnce()
  })
})

function fakeClient(connect: () => void): EventEmitter & {
  connect: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
} {
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn(connect),
    end: vi.fn(() => client.emit('close')),
    destroy: vi.fn(() => client.emit('close')),
  })
  return client
}

type ExecChannel = EventEmitter & { end: ReturnType<typeof vi.fn> }

function execBudgetFixture(channelCount: number, maxConcurrentExecs?: number) {
  const channels = Array.from({ length: channelCount }, () => {
    const channel: ExecChannel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      close: vi.fn(() => channel.emit('close')),
      end: vi.fn(),
    })
    return channel
  })
  let next = 0
  const client = Object.assign(
    fakeClient(() => undefined),
    {
      exec: vi.fn(
        (
          _command: string,
          callback: (error: Error | undefined, value: unknown) => void,
        ) => callback(undefined, channels[next++]),
      ),
    },
  )
  const host = createTestSshHost({
    config: aliasConfig(),
    prompter: { prompt: () => Promise.resolve(undefined) },
    ...(maxConcurrentExecs === undefined ? {} : { maxConcurrentExecs }),
  })
  const internals = host as unknown as { state: 'connected'; client: Client }
  internals.state = 'connected'
  internals.client = client as unknown as Client
  return { host, client, channels }
}

function settleExec(channel: ExecChannel | undefined): void {
  if (!channel) throw new Error('Expected a prepared exec channel')
  channel.emit('exit', 0)
  channel.emit('close')
}

function aliasConfig() {
  return {
    alias: 'example',
    hostname: 'example.test',
    user: 'picard',
    port: 22,
    identityFiles: [],
  }
}
