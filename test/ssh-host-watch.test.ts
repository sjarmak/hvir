import { describe, expect, it, vi } from 'vitest'

import {
  SshHost,
  type Disposer,
  type ExecStreamHandle,
  type WatchOptions,
} from '../src/main/project-host'
import type { SshFileAccess } from '../src/main/project-host/ssh-file-access'
import type { SshWatchService } from '../src/main/project-host/ssh-watch-service'
import { asHostId, hostPath, type HostPath, type WatchEvent } from '../src/shared'
import { createTestSshHost } from './ssh-host-test-fixture'

describe('SshHost watch behavior', () => {
  it('content-fingerprints only viewer-fetched files during polling', async () => {
    let contents = Buffer.from('first')
    const attrs = { mode: 0o100644, mtime: 100, size: 5, atime: 100 }
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { ...attrs, mode: 0o040755, size: 0 }),
      ),
      readdir: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown[]) => void) =>
          callback(undefined, [
            { filename: 'open.txt', attrs },
            { filename: 'closed.txt', attrs },
          ]),
      ),
      readFile: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, contents),
      ),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const files = hostFiles<{
      pollingFiles: Set<string>
      getSftp(): Promise<unknown>
    }>(host)
    const watches = hostWatches<{
      pollPrioritySnapshot(
        path: HostPath,
        opts: WatchOptions,
      ): Promise<Map<string, string>>
    }>(host)
    files.pollingFiles.add('/project/open.txt')
    files.getSftp = () => Promise.resolve(session)

    const before = await watches.pollPrioritySnapshot(hostPath(host.hostId, '/project'), {
      recursive: false,
    })
    contents = Buffer.from('later')
    const after = await watches.pollPrioritySnapshot(hostPath(host.hostId, '/project'), {
      recursive: false,
    })

    expect(before.get('/project/open.txt')).not.toBe(after.get('/project/open.txt'))
    expect(before.get('/project/closed.txt')).toBe(after.get('/project/closed.txt'))
    expect(session.readFile).toHaveBeenCalledTimes(2)
    expect(session.readFile).toHaveBeenCalledWith(
      '/project/open.txt',
      expect.any(Function),
    )
  })

  it('retains the digest of a stable old file without downloading it again', async () => {
    vi.useFakeTimers()
    try {
      const attrs = { mode: 0o100644, mtime: 100, size: 6, atime: 100 }
      const session = {
        lstat: vi.fn(
          (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
            callback(undefined, { ...attrs, mode: 0o040755, size: 0 }),
        ),
        readdir: vi.fn(
          (
            _path: string,
            callback: (error: Error | undefined, value: unknown[]) => void,
          ) => callback(undefined, [{ filename: 'open.txt', attrs }]),
        ),
        readFile: vi.fn(
          (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
            callback(undefined, Buffer.from('stable')),
        ),
      }
      const host = createTestSshHost({
        config: aliasConfig(),
        fingerprintObservationWindowMs: 10,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const files = hostFiles<{
        pollingFiles: Set<string>
        getSftp(): Promise<unknown>
      }>(host)
      const watches = hostWatches<{
        pollPrioritySnapshot(
          path: HostPath,
          opts: WatchOptions,
        ): Promise<Map<string, string>>
      }>(host)
      files.pollingFiles.add('/project/open.txt')
      files.getSftp = () => Promise.resolve(session)
      const root = hostPath(host.hostId, '/project')

      const first = await watches.pollPrioritySnapshot(root, { recursive: false })
      await vi.advanceTimersByTimeAsync(11)
      const second = await watches.pollPrioritySnapshot(root, { recursive: false })
      const third = await watches.pollPrioritySnapshot(root, { recursive: false })

      expect(second).toEqual(first)
      expect(third).toEqual(first)
      expect(session.readFile).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not put internal bulk reads on the polling fast path', async () => {
    const session = {
      readFile: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, Buffer.from('contents')),
      ),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const internals = hostFiles<{
      pollingFiles: Set<string>
      readDigests: Map<string, string>
      getSftp(): Promise<unknown>
    }>(host)
    internals.getSftp = () => Promise.resolve(session)
    const internal = hostPath(host.hostId, '/project/untracked.txt')
    const visible = hostPath(host.hostId, '/project/open.txt')

    await host.readTextFile(internal)
    await host.readFile(visible, { pollingInterest: true })

    expect(internals.pollingFiles).toEqual(new Set(['/project/open.txt']))
    expect(internals.readDigests.has('/project/untracked.txt')).toBe(false)
    expect(internals.readDigests.has('/project/open.txt')).toBe(true)
  })

  it('content-fingerprints Git metadata on a nonrecursive watch', async () => {
    const attrs = { mode: 0o100644, mtime: 100, size: 5, atime: 100 }
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, { ...attrs, mode: 0o040755 }),
      ),
      readdir: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown[]) => void) =>
          callback(undefined, [
            { filename: 'HEAD', attrs },
            { filename: 'index', attrs },
            { filename: 'config', attrs },
          ]),
      ),
      readFile: vi.fn(
        (path: string, callback: (error: Error | undefined, value: Buffer) => void) =>
          callback(undefined, Buffer.from(path)),
      ),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const files = hostFiles<{ getSftp(): Promise<unknown> }>(host)
    const watches = hostWatches<{
      getSftp(): Promise<unknown>
      pollPrioritySnapshot(
        path: HostPath,
        opts: WatchOptions,
      ): Promise<Map<string, string>>
    }>(host)
    files.getSftp = () => Promise.resolve(session)

    await watches.pollPrioritySnapshot(hostPath(host.hostId, '/project/.git'), {
      recursive: false,
    })

    expect(session.readFile).toHaveBeenCalledTimes(2)
    expect(session.readFile).toHaveBeenCalledWith(
      '/project/.git/HEAD',
      expect.any(Function),
    )
    expect(session.readFile).toHaveBeenCalledWith(
      '/project/.git/index',
      expect.any(Function),
    )
  })

  it('polls shallow additional watch paths through one snapshot backend', async () => {
    const directoryAttrs = { mode: 0o040755, mtime: 100, size: 0, atime: 100 }
    const fileAttrs = { mode: 0o100644, mtime: 100, size: 5, atime: 100 }
    const session = {
      lstat: vi.fn(
        (_path: string, callback: (error: Error | undefined, value: unknown) => void) =>
          callback(undefined, directoryAttrs),
      ),
      readdir: vi.fn(
        (path: string, callback: (error: Error | undefined, value: unknown[]) => void) =>
          callback(undefined, [
            {
              filename: path === '/project' ? 'top.txt' : 'nested.txt',
              attrs: fileAttrs,
            },
          ]),
      ),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const files = hostFiles<{ getSftp(): Promise<unknown> }>(host)
    const watches = hostWatches<{
      pollPrioritySnapshot(
        path: HostPath,
        opts: WatchOptions,
      ): Promise<Map<string, string>>
    }>(host)
    files.getSftp = () => Promise.resolve(session)
    const expanded = hostPath(host.hostId, '/project/expanded')

    const snapshot = await watches.pollPrioritySnapshot(
      hostPath(host.hostId, '/project'),
      { recursive: false, additionalPaths: [expanded] },
    )

    expect(session.readdir).toHaveBeenCalledTimes(2)
    expect(snapshot.has('/project/top.txt')).toBe(true)
    expect(snapshot.has('/project/expanded/nested.txt')).toBe(true)
  })

  it('never overlaps remote polling snapshots', async () => {
    vi.useFakeTimers()
    try {
      const host = createTestSshHost({
        config: aliasConfig(),
        pollIntervalMs: 10,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      let finishFirst: ((snapshot: Map<string, string>) => void) | undefined
      const first = new Promise<Map<string, string>>((resolve) => {
        finishFirst = resolve
      })
      const snapshot = vi
        .fn<() => Promise<Map<string, string>>>()
        .mockReturnValueOnce(first)
        .mockResolvedValue(new Map())
      const internals = hostWatches<{
        pollPrioritySnapshot(
          path: HostPath,
          opts: WatchOptions,
        ): Promise<Map<string, string>>
        pollDirectoryBatch(queue: string[]): Promise<void>
        watchPolling(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }>(host)
      internals.pollPrioritySnapshot = snapshot
      internals.pollDirectoryBatch = (queue) => {
        queue.length = 0
        return Promise.resolve()
      }
      const stop = internals.watchPolling(
        hostPath(asHostId('example'), '/project'),
        () => undefined,
        {},
      )

      await vi.advanceTimersByTimeAsync(100)
      expect(snapshot).toHaveBeenCalledOnce()
      finishFirst?.(new Map())
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10)
      expect(snapshot).toHaveBeenCalledTimes(2)
      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds recursive safety work and adaptively backs off idle cycles', async () => {
    vi.useFakeTimers()
    try {
      const host = createTestSshHost({
        config: aliasConfig(),
        pollIntervalMs: 10,
        slowScanIntervalMs: 20,
        maxSlowScanIntervalMs: 80,
        pollDirectoryBatchSize: 2,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const priority = vi.fn(() => Promise.resolve(new Map<string, string>()))
      const batch = vi.fn(
        (
          queue: string[],
          _visited: Set<string>,
          _snapshot: Map<string, string>,
          _opts: WatchOptions,
          limit: number,
        ) => {
          expect(limit).toBe(2)
          queue.length = 0
          return Promise.resolve()
        },
      )
      const internals = hostWatches<{
        pollPrioritySnapshot(): Promise<Map<string, string>>
        pollDirectoryBatch(
          queue: string[],
          visited: Set<string>,
          snapshot: Map<string, string>,
          opts: WatchOptions,
          limit: number,
        ): Promise<void>
        watchPolling(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }>(host)
      internals.pollPrioritySnapshot = priority
      internals.pollDirectoryBatch = batch
      const stop = internals.watchPolling(
        hostPath(host.hostId, '/project'),
        () => undefined,
        { recursive: true },
      )

      await vi.advanceTimersByTimeAsync(0)
      expect(batch).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(39)
      expect(priority).toHaveBeenCalledTimes(4)
      expect(batch).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(batch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(79)
      expect(batch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(batch).toHaveBeenCalledTimes(3)

      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('enumerates only the configured number of directories per safety tick', async () => {
    const directoryAttrs = { mode: 0o040755, mtime: 100, size: 0, atime: 100 }
    const session = {
      readdir: vi.fn(
        (path: string, callback: (error: Error | undefined, value: unknown[]) => void) =>
          callback(
            undefined,
            path === '/project'
              ? ['a', 'b', 'c'].map((filename) => ({
                  filename,
                  attrs: directoryAttrs,
                }))
              : [],
          ),
      ),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const files = hostFiles<{ getSftp(): Promise<unknown> }>(host)
    const watches = hostWatches<{
      pollDirectoryBatch(
        queue: string[],
        visited: Set<string>,
        snapshot: Map<string, string>,
        opts: WatchOptions,
        limit: number,
      ): Promise<void>
    }>(host)
    files.getSftp = () => Promise.resolve(session)
    const queue = ['/project']
    const visited = new Set(queue)
    const snapshot = new Map<string, string>()

    await watches.pollDirectoryBatch(queue, visited, snapshot, {}, 1)

    expect(session.readdir).toHaveBeenCalledOnce()
    expect(queue).toEqual(['/project/a', '/project/b', '/project/c'])
    expect(snapshot.size).toBe(3)
  })

  it('uses a polling watchdog when inotify stays silent', async () => {
    vi.useFakeTimers()
    try {
      const host = createTestSshHost({
        config: aliasConfig(),
        watchdogIntervalMs: 10,
        slowScanIntervalMs: 10,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const root = hostPath(asHostId('example'), '/project')
      const added = '/project/generated'
      const snapshot = vi
        .fn<() => Promise<Map<string, string>>>()
        .mockResolvedValueOnce(new Map())
        .mockResolvedValueOnce(new Map([[added, 'dir:1:0:16877']]))
        .mockResolvedValueOnce(new Map())
      const silentInotify: ExecStreamHandle = {
        onStdout: () => () => undefined,
        onStderr: () => () => undefined,
        onError: () => () => undefined,
        onExit: () => () => undefined,
        write: () => Promise.resolve(),
        end: () => Promise.resolve(),
        kill: () => undefined,
        dispose: vi.fn(),
      }
      const hostInternals = host as unknown as {
        execStream(): ExecStreamHandle
      }
      const files = hostFiles<{ cache: Map<string, unknown> }>(host)
      const watches = hostWatches<{
        pollPrioritySnapshot(
          path: HostPath,
          opts: WatchOptions,
        ): Promise<Map<string, string>>
        pollDirectoryBatch(queue: string[]): Promise<void>
        watchInotify(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }>(host)
      hostInternals.execStream = () => silentInotify
      watches.pollPrioritySnapshot = snapshot
      watches.pollDirectoryBatch = (queue) => {
        queue.length = 0
        return Promise.resolve()
      }
      const events: WatchEvent[] = []
      const stop = watches.watchInotify(root, (event) => events.push(event), {})

      await Promise.resolve()
      await Promise.resolve()
      expect(snapshot).toHaveBeenCalledOnce()
      files.cache.set('d:/project', {})
      await vi.advanceTimersByTimeAsync(10)
      expect(snapshot).toHaveBeenCalledTimes(2)
      expect(events).toContainEqual({
        type: 'addDir',
        path: hostPath(root.hostId, added),
      })
      expect(files.cache.has('d:/project')).toBe(false)

      files.cache.set('d:/project', {})
      await vi.advanceTimersByTimeAsync(10)
      expect(snapshot).toHaveBeenCalledTimes(3)
      expect(events).toContainEqual({
        type: 'unlinkDir',
        path: hostPath(root.hostId, added),
      })
      expect(files.cache.has('d:/project')).toBe(false)

      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies both sides of an inotify directory rename', async () => {
    let emitStdout: ((value: string) => void) | undefined
    const inotify: ExecStreamHandle = {
      onStdout: (callback) => {
        emitStdout = callback
        return () => undefined
      },
      onStderr: () => () => undefined,
      onError: () => () => undefined,
      onExit: () => () => undefined,
      write: () => Promise.resolve(),
      end: () => Promise.resolve(),
      kill: () => undefined,
      dispose: vi.fn(),
    }
    const host = createTestSshHost({
      config: aliasConfig(),
      watchdogIntervalMs: 60_000,
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    const hostInternals = host as unknown as {
      execStream(): ExecStreamHandle
    }
    const internals = hostWatches<{
      pollPrioritySnapshot(
        path: HostPath,
        opts: WatchOptions,
      ): Promise<Map<string, string>>
      pollDirectoryBatch(queue: string[]): Promise<void>
      watchInotify(
        path: HostPath,
        onEvent: (event: WatchEvent) => void,
        opts: WatchOptions,
      ): Disposer
    }>(host)
    hostInternals.execStream = () => inotify
    internals.pollPrioritySnapshot = () => Promise.resolve(new Map<string, string>())
    internals.pollDirectoryBatch = (queue) => {
      queue.length = 0
      return Promise.resolve()
    }
    const events: WatchEvent[] = []
    const root = hostPath(host.hostId, '/project')
    const stop = internals.watchInotify(root, (event) => events.push(event), {})

    emitStdout?.('MOVED_FROM,ISDIR|/project/old\nMOVED_TO,ISDIR|/project/new\n')

    expect(events).toEqual([
      { type: 'unlinkDir', path: hostPath(host.hostId, '/project/old') },
      { type: 'addDir', path: hostPath(host.hostId, '/project/new') },
    ])
    await stop()
  })

  it('emits a bounded tree refresh pulse even when the watch backend stalls', async () => {
    vi.useFakeTimers()
    try {
      const host = createTestSshHost({
        config: aliasConfig(),
        refreshPulseIntervalMs: 10,
        prompter: { prompt: () => Promise.resolve(undefined) },
      })
      const root = hostPath(asHostId('example'), '/project')
      const stopBackend = vi.fn()
      const hostInternals = host as unknown as {
        state: 'connected'
        tier: 'inotify'
      }
      const internals = hostWatches<{
        watchInotify(
          path: HostPath,
          onEvent: (event: WatchEvent) => void,
          opts: WatchOptions,
        ): Disposer
      }>(host)
      hostInternals.state = 'connected'
      hostInternals.tier = 'inotify'
      internals.watchInotify = () => stopBackend
      const events: WatchEvent[] = []

      const stop = host.watch(root, (event) => events.push(event))
      await vi.advanceTimersByTimeAsync(9)
      expect(events).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(events).toEqual([{ type: 'change', path: root, synthetic: 'refresh' }])

      await stop()
      await vi.advanceTimersByTimeAsync(20)
      expect(events).toHaveLength(1)
      expect(stopBackend).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses an in-flight polling error after the watcher stops', async () => {
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    let failSnapshot: ((error: Error) => void) | undefined
    const snapshot = vi.fn(
      () =>
        new Promise<Map<string, string>>((_resolve, reject) => {
          failSnapshot = reject
        }),
    )
    const internals = hostWatches<{
      pollPrioritySnapshot(
        path: HostPath,
        opts: WatchOptions,
      ): Promise<Map<string, string>>
      watchPolling(
        path: HostPath,
        onEvent: (event: WatchEvent) => void,
        opts: WatchOptions,
      ): Disposer
    }>(host)
    internals.pollPrioritySnapshot = snapshot
    const onError = vi.fn()
    const stop = internals.watchPolling(
      hostPath(asHostId('example'), '/project'),
      () => undefined,
      { onError },
    )

    await stop()
    failSnapshot?.(new Error('No response from server'))
    await Promise.resolve()
    await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()
  })
})

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

function hostWatches<T extends object = SshWatchService>(host: SshHost): T {
  return (host as unknown as { watches: T }).watches
}
