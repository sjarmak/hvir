import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { SshHost } from '../src/main/project-host'
import type { SshFileAccess } from '../src/main/project-host/ssh-file-access'
import { hostPath } from '../src/shared'
import { createTestSshHost } from './ssh-host-test-fixture'

describe('SshHost remote behavior', () => {
  it('truthfully discloses permanent deletion without a remote trash helper', async () => {
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => fakeClient(() => undefined) as unknown as Client,
    })

    expect(host.fileDeletion).toEqual({ capability: 'permanent' })
    expect('trashEntry' in host.fileDeletion).toBe(false)
    await host.dispose()
  })

  it('connects, probes, and executes through the default buffered slot', async () => {
    const client = Object.assign(
      fakeClient(() => queueMicrotask(() => client.emit('ready'))),
      {
        exec: vi.fn(
          (
            _command: string,
            callback: (error: Error | undefined, value: unknown) => void,
          ) => {
            const channel = Object.assign(new EventEmitter(), {
              stderr: new EventEmitter(),
              close: vi.fn(),
              end: vi.fn(() =>
                queueMicrotask(() => {
                  channel.emit('exit', 0)
                  channel.emit('close')
                }),
              ),
            })
            callback(undefined, channel)
          },
        ),
      },
    )
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => client as unknown as Client,
    })

    await host.connect()
    await expect(host.exec('true', [])).resolves.toMatchObject({ code: 0 })
    expect(client.exec).toHaveBeenCalledTimes(2)
    await host.dispose()
  })

  it.each([
    ['agent socket', 'agent', 'connect ENOENT'],
    ['key signing', 'client-authentication', 'Error signing data with key: denied'],
  ])('continues after a recoverable %s error', async (_label, level, message) => {
    const client = fakeClient(() => {
      queueMicrotask(() => {
        client.emit('error', Object.assign(new Error(message), { level }))
        client.emit('ready')
      })
    })
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => client as unknown as Client,
    })
    vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })

    await expect(host.connect()).resolves.toBeUndefined()
    expect(host.connectionState).toBe('connected')
    await host.dispose()
  })

  it('still rejects a fatal error after a recoverable auth error', async () => {
    const client = fakeClient(() => {
      queueMicrotask(() => {
        client.emit(
          'error',
          Object.assign(new Error('agent unavailable'), { level: 'agent' }),
        )
        client.emit(
          'error',
          Object.assign(new Error('socket failed'), { level: 'client-socket' }),
        )
      })
    })
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => client as unknown as Client,
    })

    await expect(host.connect()).rejects.toThrow('socket failed')
    await host.dispose()
  })

  it('cancels a connecting transport even when ssh2 emits no close event', async () => {
    vi.useFakeTimers()
    try {
      const silent = fakeClient(() => undefined)
      silent.end.mockImplementation(() => undefined)
      const host = createTestSshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(undefined) },
        clientFactory: () => silent as unknown as Client,
      })
      const connecting = host.connect()
      const rejected = expect(connecting).rejects.toThrow('SSH connection cancelled')
      const disposing = host.dispose()
      await vi.advanceTimersByTimeAsync(1_000)
      await disposing

      await rejected
      expect(host.connectionState).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a pre-ready close and allows a later explicit reconnect', async () => {
    const closing = fakeClient(() => queueMicrotask(() => closing.emit('close')))
    const ready = fakeClient(() => queueMicrotask(() => ready.emit('ready')))
    const clients = [closing, ready]
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => clients.shift() as unknown as Client,
    })
    vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })

    await expect(host.connect()).rejects.toThrow(
      'SSH connection closed before authentication completed',
    )
    await expect(host.connect()).resolves.toBeUndefined()
    expect(host.connectionState).toBe('connected')
    await host.dispose()
  })

  it('does not let a late close from an old client clobber a new client', async () => {
    const oldClient = fakeClient(() => queueMicrotask(() => oldClient.emit('ready')))
    const newClient = fakeClient(() => queueMicrotask(() => newClient.emit('ready')))
    const clients = [oldClient, newClient]
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => clients.shift() as unknown as Client,
    })
    vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const internals = host as unknown as {
      open(): Promise<void>
      client?: Client
    }

    await internals.open()
    await internals.open()
    oldClient.emit('close')

    expect(internals.client).toBe(newClient)
    expect(host.connectionState).toBe('connected')
    await host.dispose()
  })

  it('keeps an authenticated transport when capability detection fails', async () => {
    const client = fakeClient(() => queueMicrotask(() => client.emit('ready')))
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => client as unknown as Client,
    })
    vi.spyOn(host, 'exec').mockRejectedValue(new Error('probe unavailable'))

    await expect(host.connect()).resolves.toBeUndefined()
    expect(host.connectionState).toBe('connected')
    expect(host.watchTier).toBe('polling')
    await host.dispose()
  })

  it('waits briefly for the SSH transport to close during disposal', async () => {
    vi.useFakeTimers()
    try {
      const host = createTestSshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const client = Object.assign(new EventEmitter(), {
        end: vi.fn(() => setTimeout(() => client.emit('close'), 25)),
      })
      ;(host as unknown as { client: typeof client }).client = client
      let finished = false
      const disposing = host.dispose().then(() => {
        finished = true
      })

      await vi.advanceTimersByTimeAsync(24)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await disposing
      expect(finished).toBe(true)
      expect(client.end).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('force-destroys a transport that does not close during disposal', async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient(() => undefined)
      client.end.mockImplementation(() => undefined)
      client.destroy.mockImplementation(() => undefined)
      const host = createTestSshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      ;(host as unknown as { client: Client }).client = client as unknown as Client

      const disposing = host.dispose()
      await vi.advanceTimersByTimeAsync(1_000)
      await disposing

      expect(client.destroy).toHaveBeenCalledOnce()
      expect(host.connectionState).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not implicitly reconnect after an explicit disconnect', async () => {
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    await host.dispose()
    const connect = vi.spyOn(host, 'connect')

    await expect(host.exec('true', [])).rejects.toThrow(
      'SSH host is disconnected; reconnect explicitly before retrying',
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it('cancels a scheduled reconnect on explicit disconnect', async () => {
    vi.useFakeTimers()
    try {
      const factory = vi.fn<() => Client>()
      const host = createTestSshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(undefined) },
        clientFactory: factory,
      })
      ;(host as unknown as { scheduleReconnect(): void }).scheduleReconnect()

      await host.dispose()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(factory).not.toHaveBeenCalled()
      expect(host.connectionState).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not loop modal authentication after one automatic reconnect failure', async () => {
    vi.useFakeTimers()
    try {
      const host = createTestSshHost({
        config: aliasConfig(),
        prompter: { prompt: () => Promise.resolve(['wrong']) },
      })
      const internals = host as unknown as {
        promptedDuringConnect: boolean
        beginConnect(): Promise<void>
        scheduleReconnect(): void
      }
      internals.promptedDuringConnect = true
      const reconnect = vi
        .spyOn(internals, 'beginConnect')
        .mockRejectedValue(new Error('authentication failed'))

      internals.scheduleReconnect()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(reconnect).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(reconnect).toHaveBeenCalledOnce()
      await host.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses one multiplexed SFTP session for concurrent operations', async () => {
    const session = Object.assign(new EventEmitter(), { end: vi.fn() })
    const client = Object.assign(
      fakeClient(() => undefined),
      {
        sftp: vi.fn((callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, session),
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

    const [first, second] = await Promise.all([
      hostFiles(host).getSftp(),
      hostFiles(host).getSftp(),
    ])

    expect(first).toBe(session)
    expect(second).toBe(session)
    expect(client.sftp).toHaveBeenCalledOnce()
    await host.dispose()
    expect(session.end).toHaveBeenCalledOnce()
  })

  it('resolves and browses an in-project remote directory symlink', async () => {
    const session = {
      realpath: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: string) => void) =>
          callback(undefined, '/project/target'),
      ),
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, {
            mode: 0o040755,
            size: 0,
            mtime: 100,
          }),
      ),
      readdir: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown[]) => void) =>
          callback(undefined, [
            {
              filename: 'inside.txt',
              attrs: { mode: 0o100644, size: 7, mtime: 100 },
            },
          ]),
      ),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(hostFiles(host) as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)
    const link = hostPath(host.hostId, '/project/linked')

    expect((await host.realpath(link)).path).toBe('/project/target')
    expect((await host.stat(hostPath(host.hostId, '/project/target'))).type).toBe('dir')
    expect((await host.readdir(link)).map((entry) => entry.name)).toEqual(['inside.txt'])
  })

  it('saves through a same-directory temporary file and atomic rename', async () => {
    const operations: string[] = []
    const session = {
      lstat: vi.fn(
        (
          path: string,
          callback: (error: Error | undefined, attrs: { mode: number }) => void,
        ) => {
          operations.push(`stat:${path}`)
          callback(undefined, { mode: 0o100640 })
        },
      ),
      writeFile: vi.fn(
        (
          path: string,
          _data: Buffer,
          options: { mode?: number },
          callback: (error?: Error) => void,
        ) => {
          operations.push(`write:${path}:${String(options.mode)}`)
          callback()
        },
      ),
      ext_openssh_rename: vi.fn(
        (source: string, target: string, callback: (error?: Error) => void) => {
          operations.push(`rename:${source}:${target}`)
          callback()
        },
      ),
      rename: vi.fn(),
      unlink: vi.fn(),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(hostFiles(host) as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)

    await host.writeFile(hostPath(host.hostId, '/project/file.txt'), 'replacement')

    expect(operations).toHaveLength(3)
    expect(operations[0]).toBe('stat:/project/file.txt')
    expect(operations[1]).toMatch(
      /^write:\/project\/\.file\.txt\.hvir-[0-9a-f-]+\.tmp:416$/,
    )
    expect(operations[2]).toMatch(
      /^rename:\/project\/\.file\.txt\.hvir-[0-9a-f-]+\.tmp:\/project\/file\.txt$/,
    )
    expect(session.rename).not.toHaveBeenCalled()
    expect(session.unlink).not.toHaveBeenCalled()
  })

  it('delegates exclusive file and directory creation through deterministic SFTP mechanics', async () => {
    const handle = Buffer.from('handle')
    const session = {
      open: vi.fn(
        (
          _path: string,
          _flags: string,
          _attrs: unknown,
          callback: (error: Error | undefined, value: Buffer) => void,
        ) => callback(undefined, handle),
      ),
      fsetstat: vi.fn(
        (_handle: Buffer, _attrs: unknown, callback: (error?: Error) => void) =>
          callback(),
      ),
      close: vi.fn((_handle: Buffer, callback: (error?: Error) => void) => callback()),
      mkdir: vi.fn((_path: string, _attrs: unknown, callback: (error?: Error) => void) =>
        callback(),
      ),
      setstat: vi.fn(
        (_path: string, _attrs: unknown, callback: (error?: Error) => void) => callback(),
      ),
      lstat: vi.fn(
        (path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, {
            mode: path.endsWith('.txt') ? 0o100644 : 0o040755,
            size: 0,
            mtime: 100,
          }),
      ),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(hostFiles(host) as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)

    await host.createFileExclusive(hostPath(host.hostId, '/project/new.txt'), {
      mode: 0o644,
    })
    await host.createDirectoryExclusive(hostPath(host.hostId, '/project/new-dir'), {
      mode: 0o755,
    })

    expect(session.open).toHaveBeenCalledWith(
      '/project/new.txt',
      'wx',
      { mode: 0o644 },
      expect.any(Function),
    )
    expect(session.fsetstat).toHaveBeenCalledWith(
      handle,
      { mode: 0o644 },
      expect.any(Function),
    )
    expect(session.mkdir).toHaveBeenCalledWith(
      '/project/new-dir',
      { mode: 0o755 },
      expect.any(Function),
    )
    expect(session.setstat).toHaveBeenCalledWith(
      '/project/new-dir',
      { mode: 0o755 },
      expect.any(Function),
    )
  })

  it('normalizes an ambiguous SFTP exclusive-create failure when the target exists', async () => {
    const session = {
      open: vi.fn(
        (
          _path: string,
          _flags: string,
          _attrs: unknown,
          callback: (error: Error) => void,
        ) => callback(Object.assign(new Error('Failure'), { code: 4 })),
      ),
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { mode: 0o100644, size: 1, mtime: 100 }),
      ),
      unlink: vi.fn(),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(hostFiles(host) as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)

    await expect(
      host.createFileExclusive(hostPath(host.hostId, '/project/existing.txt'), {
        mode: 0o644,
      }),
    ).rejects.toMatchObject({ name: 'ProjectPathExistsError', code: 'EEXIST' })
    expect(session.lstat).toHaveBeenCalledWith(
      '/project/existing.txt',
      expect.any(Function),
    )
    expect(session.unlink).not.toHaveBeenCalled()
  })

  it('does not rename over a same-second external edit after a slow upload', async () => {
    let live = Buffer.from('first')
    const attrs = { mode: 0o100640, mtime: 100, size: 5, atime: 100 }
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, attrs),
      ),
      readFile: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, live),
      ),
      writeFile: vi.fn(
        (
          _path: string,
          _data: Buffer,
          _options: unknown,
          callback: (error?: Error) => void,
        ) => {
          live = Buffer.from('other')
          callback()
        },
      ),
      ext_openssh_rename: vi.fn(),
      rename: vi.fn(),
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) => callback()),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(hostFiles(host) as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)
    const path = hostPath(host.hostId, '/project/file.txt')
    await host.readFile(path, { pollingInterest: true })

    await expect(
      host.writeFile(path, 'mine!', { expectedMtimeMs: 100_000 }),
    ).rejects.toThrow('changed on the remote host')

    expect(session.ext_openssh_rename).not.toHaveBeenCalled()
    expect(session.rename).not.toHaveBeenCalled()
    expect(session.unlink).toHaveBeenCalledOnce()
  })

  it('cleans up a partial temporary when an atomic remote write fails', async () => {
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { mode: 0o100640, mtime: 100, size: 5 }),
      ),
      writeFile: vi.fn(
        (
          _path: string,
          _data: Buffer,
          _options: unknown,
          callback: (error: Error) => void,
        ) => callback(new Error('network dropped')),
      ),
      ext_openssh_rename: vi.fn(),
      rename: vi.fn(),
      unlink: vi.fn((_path: string, callback: (error?: Error) => void) => callback()),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    ;(hostFiles(host) as unknown as { getSftp(): Promise<unknown> }).getSftp = () =>
      Promise.resolve(session)

    await expect(
      host.writeFile(hostPath(host.hostId, '/project/file.txt'), 'replacement'),
    ).rejects.toThrow('network dropped')

    expect(session.ext_openssh_rename).not.toHaveBeenCalled()
    expect(session.rename).not.toHaveBeenCalled()
    expect(session.unlink).toHaveBeenCalledOnce()
  })

  it('decodes remote exec output across UTF-8 chunk boundaries', async () => {
    const stderr = new EventEmitter()
    const channel = Object.assign(new EventEmitter(), {
      stderr,
      close: vi.fn(() => channel.emit('close')),
      end: vi.fn(() => {
        channel.emit('data', Buffer.from([0xe2]))
        queueMicrotask(() => {
          channel.emit('data', Buffer.from([0x82, 0xac]))
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

    const result = await host.exec('printf', [])

    expect(result.stdout).toBe('€')
    expect(result.stdout).not.toContain('�')
    await host.dispose()
  })

  it('quotes structured argv and applies remote environment unsets', async () => {
    const stderr = new EventEmitter()
    let remote = ''
    const channel = Object.assign(new EventEmitter(), {
      stderr,
      close: vi.fn(() => channel.emit('close')),
      end: vi.fn(() => {
        channel.emit('exit', 0)
        channel.emit('close')
      }),
    })
    const client = Object.assign(
      fakeClient(() => undefined),
      {
        exec: vi.fn(
          (
            command: string,
            callback: (error: Error | undefined, value: unknown) => void,
          ) => {
            remote = command
            callback(undefined, channel)
          },
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

    await host.exec('printf', ['%s', "space and ' quote"], {
      cwd: hostPath(host.hostId, '/work tree'),
      env: { PROFILE_VALUE: 'a b' },
      unsetEnv: ['NODE_OPTIONS'],
    })

    expect(remote).toContain("cd -- '/work tree' && env -u 'NODE_OPTIONS'")
    expect(remote).toContain("PROFILE_VALUE='a b'")
    expect(remote).toContain(`'printf' '%s' 'space and '"'"' quote'`)
    await host.dispose()
  })

  it('returns a bounded remote prefix at the stdout record limit', async () => {
    const stderr = new EventEmitter()
    const channel = Object.assign(new EventEmitter(), {
      stderr,
      close: vi.fn(() => channel.emit('close')),
      end: vi.fn(() => {
        channel.emit('data', Buffer.from('one\0two\0three\0'))
        channel.emit('exit', 0)
        channel.emit('close')
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

    const result = await host.exec('printf', [], {
      allowTruncatedOutput: true,
      maxStdoutNulRecords: 2,
    })

    expect(result.outputTruncated).toBe(true)
    expect(result.stdout).toContain('one\0two\0')
    expect(channel.close).toHaveBeenCalledOnce()
    await host.dispose()
  })

  it('recovers a buffered command status when the server omits exit-status', async () => {
    const stderr = new EventEmitter()
    let remote = ''
    const channel = Object.assign(new EventEmitter(), {
      stderr,
      close: vi.fn(() => channel.emit('close')),
      end: vi.fn(() => {
        const marker = remote.match(/__hvir_exec_status_[0-9a-f-]+__/)?.[0]
        if (!marker) throw new Error('Expected buffered exec status marker')
        stderr.emit('data', Buffer.from(`old git usage\n${marker}129`))
        channel.emit('close')
      }),
    })
    const client = Object.assign(
      fakeClient(() => undefined),
      {
        exec: vi.fn(
          (
            command: string,
            callback: (error: Error | undefined, value: unknown) => void,
          ) => {
            remote = command
            callback(undefined, channel)
          },
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

    await expect(host.exec('git', ['worktree', 'list'])).resolves.toEqual({
      code: 129,
      signal: null,
      stdout: '',
      stderr: 'old git usage\n',
    })
    expect(remote).toContain('hvir_status=$?')
    await host.dispose()
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

function aliasConfig() {
  return {
    alias: 'example',
    hostname: 'example.test',
    user: 'picard',
    port: 22,
    identityFiles: [],
  }
}

function hostFiles<T extends object = SshFileAccess>(host: SshHost): T {
  return (host as unknown as { files: T }).files
}
