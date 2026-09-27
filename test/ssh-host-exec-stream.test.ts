import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { expect, it, vi } from 'vitest'

import { createTestSshHost } from './ssh-host-test-fixture'

it('routes a streaming login-shell exec through the remote default shell', async () => {
  const channel = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    close: vi.fn(() => channel.emit('close')),
    end: vi.fn(() => queueMicrotask(() => channel.emit('close'))),
  })
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn(),
    end: vi.fn(() => client.emit('close')),
    destroy: vi.fn(() => client.emit('close')),
    exec: vi.fn(
      (_command: string, callback: (error: Error | undefined, value: unknown) => void) =>
        callback(undefined, channel),
    ),
  })
  const host = createTestSshHost({
    config: {
      alias: 'example',
      hostname: 'example.test',
      user: 'picard',
      port: 22,
      identityFiles: [],
    },
    prompter: { prompt: () => Promise.resolve(undefined) },
  })
  const internals = host as unknown as {
    state: 'connected'
    client: Client
    resolvedShell: string
  }
  internals.state = 'connected'
  internals.client = client as unknown as Client
  internals.resolvedShell = '/bin/fish'
  const stream = host.execStream('printf', ['hi'], { loginShell: true })

  await vi.waitFor(() => expect(client.exec).toHaveBeenCalledOnce())

  expect(client.exec.mock.calls[0]?.[0]).toContain("'/bin/fish' -l -c")
  stream.dispose()
  await host.dispose()
})
