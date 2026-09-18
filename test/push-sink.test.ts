import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CompanionConfigStore,
  type CompanionSecretStorage,
  type CompanionStoreFile,
} from '../src/main/companion/companion-config-store'
import { CompanionSettings } from '../src/main/companion/companion-settings'
import {
  companionPushSinkFactory,
  createNtfyPushSink,
  type PushMessage,
} from '../src/main/companion/push-sink'
import { localPath } from '../src/shared'

interface Recorded {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
}

type Respond = (request: Recorded, response: ServerResponse) => void

interface Sink {
  readonly url: string
  readonly requests: readonly Recorded[]
  stop(): Promise<void>
}

const MESSAGE: PushMessage = {
  project: 'hvir',
  title: 'Claude Code · main',
  kind: 'ready',
}

const running: Sink[] = []

afterEach(async () => {
  for (const sink of running.splice(0)) await sink.stop()
})

async function startSink(respond: Respond): Promise<Sink> {
  const requests: Recorded[] = []
  const server: Server = createServer((incoming: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.once('end', () => {
      const recorded: Recorded = {
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        headers: incoming.headers as Readonly<Record<string, string | undefined>>,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(recorded)
      respond(recorded, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const sink: Sink = {
    url: `http://127.0.0.1:${port}/hvir`,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  running.push(sink)
  return sink
}

function answering(status: number): Promise<Sink> {
  return startSink((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end('{}')
  })
}

describe('createNtfyPushSink', () => {
  it('posts the project, title and kind once as one text/plain request', async () => {
    const server = await answering(200)
    const sink = createNtfyPushSink({ url: server.url })

    await expect(sink.send(MESSAGE)).resolves.toEqual({ outcome: 'sent' })

    expect(server.requests).toHaveLength(1)
    const [request] = server.requests
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/hvir')
    expect(request?.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(request?.headers['title']).toBe('ready')
    expect(request?.headers['authorization']).toBeUndefined()
    expect(request?.body).toBe('hvir / Claude Code · main')
  })

  it('appends the pending prompt line after the pointer', async () => {
    const server = await answering(200)
    const sink = createNtfyPushSink({ url: server.url })

    await sink.send({ ...MESSAGE, kind: 'bell', line: 'Allow the edit to src/a.ts?' })

    expect(server.requests[0]?.headers['title']).toBe('bell')
    expect(server.requests[0]?.body).toBe(
      'hvir / Claude Code · main\nAllow the edit to src/a.ts?',
    )
  })

  it('sends the bearer only when a token is configured', async () => {
    const server = await answering(200)
    const sink = createNtfyPushSink({ url: server.url, token: 'tk_secret' })

    await sink.send(MESSAGE)

    expect(server.requests[0]?.headers['authorization']).toBe('Bearer tk_secret')
  })

  it.each([
    [201, { outcome: 'sent' }],
    [400, { outcome: 'failed', reason: 'rejected' }],
    [401, { outcome: 'failed', reason: 'rejected' }],
    [503, { outcome: 'failed', reason: 'rejected' }],
    [302, { outcome: 'failed', reason: 'protocol' }],
  ])('classifies a %s answer', async (status, expected) => {
    const server = await startSink((_request, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' })
      response.end('answer')
    })
    const sink = createNtfyPushSink({ url: server.url })

    await expect(sink.send(MESSAGE)).resolves.toEqual(expected)
    expect(server.requests).toHaveLength(1)
  })

  it('reports a refused connection as unreachable, with no second attempt', async () => {
    const server = await answering(200)
    const { url } = server
    await server.stop()
    running.splice(running.indexOf(server), 1)
    const sink = createNtfyPushSink({ url })

    await expect(sink.send(MESSAGE)).resolves.toEqual({
      outcome: 'failed',
      reason: 'unreachable',
    })
  })

  it('gives up after the timeout and never retries', async () => {
    const pending: ServerResponse[] = []
    const server = await startSink((_request, response) => {
      pending.push(response)
    })
    const sink = createNtfyPushSink({ url: server.url, timeoutMs: 50 })

    await expect(sink.send(MESSAGE)).resolves.toEqual({
      outcome: 'failed',
      reason: 'timeout',
    })
    expect(server.requests).toHaveLength(1)
    for (const response of pending) response.destroy()
  })

  it('is not configured when the url is empty, and asks nothing', async () => {
    let calls = 0
    const sink = createNtfyPushSink({
      url: '',
      fetch: () => {
        calls += 1
        return Promise.resolve(new Response(null, { status: 200 }))
      },
    })

    await expect(sink.send(MESSAGE)).resolves.toEqual({
      outcome: 'failed',
      reason: 'not-configured',
    })
    expect(calls).toBe(0)
  })

  it('treats a fetch that answers with no response as a protocol failure', async () => {
    const sink = createNtfyPushSink({
      url: 'https://ntfy.example/hvir',
      fetch: () => Promise.resolve(undefined as unknown as Response),
    })

    await expect(sink.send(MESSAGE)).resolves.toEqual({
      outcome: 'failed',
      reason: 'protocol',
    })
  })
})

function memoryFile(): CompanionStoreFile {
  let text: string | undefined
  return {
    readTextFile: () =>
      text === undefined
        ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        : Promise.resolve(text),
    writeFile: (_path, data) => {
      text = String(data)
      return Promise.resolve()
    },
  }
}

const secrets: CompanionSecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
}

async function settingsHarness(): Promise<CompanionSettings> {
  const store = await CompanionConfigStore.load(memoryFile(), localPath('/tmp/c.json'), {
    secrets,
  })
  return new CompanionSettings({ store })
}

describe('companionPushSinkFactory', () => {
  it('yields no sink until a push url is saved', async () => {
    const settings = await settingsHarness()
    const sink = companionPushSinkFactory(settings)

    expect(sink()).toBeUndefined()
  })

  it('reads the url and the decrypted token from Settings on every call', async () => {
    const server = await answering(200)
    const settings = await settingsHarness()
    const sink = companionPushSinkFactory(settings)
    await settings.save({
      enabled: true,
      port: 47811,
      push: { url: server.url, token: 'tk_secret' },
    })

    await expect(sink()?.send(MESSAGE)).resolves.toEqual({ outcome: 'sent' })
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer tk_secret')
    expect(JSON.stringify(settings.view())).not.toContain('tk_secret')

    await settings.save({ enabled: true, port: 47811, push: { url: server.url, token: '' } })
    await sink()?.send(MESSAGE)
    expect(server.requests[1]?.headers['authorization']).toBeUndefined()

    await settings.save({ enabled: true, port: 47811 })
    expect(sink()).toBeUndefined()
  })
})
