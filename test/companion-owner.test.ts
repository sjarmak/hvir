import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (): Buffer => {
      throw new Error('not in tests')
    },
    decryptString: (): string => {
      throw new Error('not in tests')
    },
  },
}))

vi.mock('electron', () => electron)

import type { MainActionableEntry } from '../src/main/attention/actionable-attention-set'
import { createCompanionAssetReader } from '../src/main/companion/companion-assets'
import type {
  CompanionSecretStorage,
  CompanionStoreFile,
} from '../src/main/companion/companion-config-store'
import {
  installApplicationCompanion,
  type ApplicationCompanion,
  type CompanionOwnerDiagnostic,
} from '../src/main/companion/companion-owner'
import {
  asHostId,
  asSessionsTerminalHandle,
  localPath,
  type CompanionConfigView,
  type CompanionSnapshot,
  type HostPath,
  type ProjectState,
} from '../src/shared'
import { companionWorld, interaction, localRoot } from './companion-sessions-fixture'

const EXTERNAL = asSessionsTerminalHandle('sessions-external-0001')
const OTHER = asSessionsTerminalHandle('sessions-external-0002')
const LOCAL = asSessionsTerminalHandle('local-session')
const REMOTE = asSessionsTerminalHandle('remote-session')
const BUNDLE_ROOT = '/bundle'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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

function secrets(): CompanionSecretStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
    decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
  }
}

function bundleHost(): {
  readFile: (path: HostPath) => Promise<Buffer>
  reads: string[]
} {
  const files = new Map<string, string>([
    [`${BUNDLE_ROOT}/companion/index.html`, '<!doctype html><title>Companion</title>'],
    [`${BUNDLE_ROOT}/assets/app-1.js`, 'console.log(1)'],
    [`${BUNDLE_ROOT}/assets/app-1.css`, 'body{}'],
    [`${BUNDLE_ROOT}/assets/app-1.js.map`, '{"version":3}'],
    [`${BUNDLE_ROOT}/secret.txt`, 'never served'],
  ])
  const host = {
    reads: [] as string[],
    readFile: (path: HostPath) => {
      host.reads.push(path.path)
      const text = files.get(path.path)
      return text === undefined
        ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        : Promise.resolve(Buffer.from(text, 'utf8'))
    },
  }
  return host
}

function emptyProjectState(): ProjectState {
  return {
    revision: 1,
    root: localRoot,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project:local:/private/repo',
    activeWorkspaceId: 'workspace:local:/private/repo',
    projects: [],
  }
}

const externalEntry: MainActionableEntry = {
  key: 'gas-city local gc-1',
  kind: 'ready',
  freshness: 'fresh',
  external: { sourceId: 'gas-city', hostId: asHostId('local'), key: 'gc-1' },
}

interface Harness {
  readonly companion: ApplicationCompanion
  readonly world: ReturnType<typeof companionWorld>
  readonly published: CompanionConfigView[]
  readonly diagnostics: CompanionOwnerDiagnostic[]
  readonly pushed: string[]
  readonly host: ReturnType<typeof bundleHost>
  readonly owned: string[]
  readonly dispose: () => Promise<void>
}

async function harness(
  options: { pending?: boolean; store?: CompanionStoreFile } = {},
): Promise<Harness> {
  const world = companionWorld(options.pending ? { pending: () => interaction() } : {})
  const owned: { label: string; dispose: () => void | Promise<void> }[] = []
  const runtime = {
    own: <T>(
      label: string,
      resource: T,
      dispose: (resource: T) => void | Promise<void>,
    ) => {
      owned.push({ label, dispose: () => dispose(resource) })
      return resource
    },
  }
  const published: CompanionConfigView[] = []
  const diagnostics: CompanionOwnerDiagnostic[] = []
  const pushed: string[] = []
  const host = bundleHost()
  const companion = await installApplicationCompanion(runtime, {
    store: {
      host: options.store ?? memoryFile(),
      file: localPath('/companion.json'),
      secrets: secrets(),
    },
    assets: createCompanionAssetReader(host, BUNDLE_ROOT),
    sessions: {
      observation: world.observation,
      transcripts: world.transcripts,
      sinks: world.sinks,
    },
    actionable: world.ports.actionable,
    describe: {
      terminals: { get: () => undefined },
      projects: { state: emptyProjectState },
      supervisor: {
        address: () => Promise.resolve({ ok: false, failure: { reason: 'disabled' } }),
      },
      external: {
        pendingSessions: () => [
          {
            hostId: asHostId('local'),
            sessionKey: 'gc-1',
            workspaceId: 'workspace:local:/private/repo',
            kind: 'tool-approval',
            freshness: 'fresh',
            title: 'city-worker',
          },
        ],
      },
    },
    publish: (view) => published.push(view),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    push: {
      fetch: (url) => {
        pushed.push(
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        )
        return Promise.resolve(new Response(null, { status: 200 }))
      },
    },
  })
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    for (const entry of owned.reverse()) await entry.dispose()
  }
  cleanups.push(dispose)
  return {
    companion,
    world,
    published,
    diagnostics,
    pushed,
    host,
    owned: owned.map((entry) => entry.label),
    dispose,
  }
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function enable(companion: ApplicationCompanion, port = 0): Promise<number> {
  await companion.settings.save({ enabled: true, port })
  await until(() => companion.settings.view().status.listening, 'listener to open')
  const bound = companion.settings.view().status.port
  if (bound === undefined) throw new Error('status reported no port')
  return bound
}

interface Reply {
  readonly status: number | undefined
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

function send(
  port: number,
  method: string,
  path: string,
  options: { headers?: OutgoingHttpHeaders; body?: unknown; raw?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload =
      options.raw ??
      (options.body === undefined ? undefined : JSON.stringify(options.body))
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      agent: false,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
    })
    let body = ''
    request.on('response', (response) => {
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body }),
      )
    })
    request.on('error', reject)
    request.end(payload)
  })
}

function bearer(token: string): OutgoingHttpHeaders {
  return { authorization: `Bearer ${token}` }
}

async function pair(companion: ApplicationCompanion, port: number): Promise<string> {
  const code = companion.settings.issuePairing().pairing?.code
  if (code === undefined) throw new Error('no pairing code issued')
  const reply = await send(port, 'POST', '/pair', { body: { code } })
  expect(reply.status).toBe(200)
  return (JSON.parse(reply.body) as { token: string }).token
}

interface Frame {
  readonly event: string
  readonly data: unknown
}

interface EventsClient {
  readonly status: number | undefined
  readonly headers: Record<string, string | string[] | undefined>
  readonly frames: Frame[]
  readonly closed: Promise<void>
  readonly pageId: string
  close(): void
}

function parseFrame(raw: string): Frame | undefined {
  const lines = raw.split('\n')
  const event = lines.find((line) => line.startsWith('event: '))?.slice(7)
  const data = lines.find((line) => line.startsWith('data: '))?.slice(6)
  if (event === undefined || data === undefined) return undefined
  return { event, data: JSON.parse(data) }
}

function openEvents(port: number, token: string): Promise<EventsClient> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/events',
      agent: false,
      headers: bearer(token),
    })
    request.on('response', (response) => {
      const frames: Frame[] = []
      let buffer = ''
      const closed = new Promise<void>((done) => response.once('close', () => done()))
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        buffer += chunk
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = parseFrame(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          if (frame) frames.push(frame)
          boundary = buffer.indexOf('\n\n')
        }
      })
      const client: EventsClient = {
        status: response.statusCode,
        headers: response.headers,
        frames,
        closed,
        pageId: String(response.headers['x-companion-page'] ?? ''),
        close: () => request.destroy(),
      }
      cleanups.push(() => client.close())
      resolve(client)
    })
    request.on('error', reject)
    request.end()
  })
}

async function firstSnapshot(client: EventsClient): Promise<CompanionSnapshot> {
  await until(() => client.frames.length > 0, 'first frame')
  const frame = client.frames[0]!
  expect(frame.event).toBe('snapshot')
  return frame.data as CompanionSnapshot
}

async function opened(
  options: { pending?: boolean } = {},
): Promise<Harness & { port: number; token: string; client: EventsClient }> {
  const world = await harness(options)
  const port = await enable(world.companion)
  const token = await pair(world.companion, port)
  const client = await openEvents(port, token)
  await firstSnapshot(client)
  return { ...world, port, token, client }
}

describe('installApplicationCompanion listener lifecycle', () => {
  it('listens nowhere while disabled and follows enable, port change and disable', async () => {
    const { companion, published } = await harness()
    expect(companion.server.listening).toBe(false)
    expect(companion.settings.view().status).toEqual({ listening: false })

    const first = await enable(companion)
    expect(companion.server.port).toBe(first)
    expect(published.at(-1)?.status).toEqual({ listening: true, port: first })
    expect((await send(first, 'GET', '/')).status).toBe(200)

    await companion.settings.save({ enabled: true, port: first })
    await until(
      () => companion.settings.view().status.port === first && companion.server.listening,
      'reopen on the named port',
    )
    expect((await send(first, 'GET', '/')).status).toBe(200)

    await companion.settings.save({ enabled: false, port: first })
    await until(() => !companion.settings.view().status.listening, 'listener to close')
    expect(companion.server.listening).toBe(false)
    await expect(send(first, 'GET', '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('reports a port it cannot bind as a status and a diagnostic, never a rejection', async () => {
    const { companion, diagnostics } = await harness()
    const blocker = createNetServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())))
    const taken = (blocker.address() as AddressInfo).port

    await companion.settings.save({ enabled: true, port: taken })
    await until(
      () => companion.settings.view().status.error !== undefined,
      'bind failure status',
    )
    expect(companion.settings.view().status).toMatchObject({ listening: false })
    expect(companion.settings.view().status.error).toContain('EADDRINUSE')
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'listener-failed', port: taken }),
    )
    expect(companion.server.listening).toBe(false)
  })
})

describe('installApplicationCompanion assets', () => {
  it('serves only the reader index and bundle assets with their content types', async () => {
    const { companion, host } = await harness()
    const port = await enable(companion)

    const index = await send(port, 'GET', '/')
    expect(index.status).toBe(200)
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(index.body).toContain('<title>Companion</title>')

    const script = await send(port, 'GET', '/assets/app-1.js')
    expect(script.status).toBe(200)
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(script.body).toBe('console.log(1)')
    expect((await send(port, 'GET', '/assets/app-1.css')).headers['content-type']).toBe(
      'text/css; charset=utf-8',
    )
    expect(
      (await send(port, 'GET', '/assets/app-1.js.map')).headers['content-type'],
    ).toBe('application/json; charset=utf-8')

    for (const path of [
      '/assets/../secret.txt',
      '/assets/%2e%2e/secret.txt',
      '/companion/index.html',
      '/assets/nested/app-1.js',
      '/assets/.hidden.js',
      '/assets/app-1.exe',
      '/assets/missing.js',
      '/secret.txt',
    ]) {
      expect((await send(port, 'GET', path)).status, path).toBe(404)
    }
    expect(host.reads.every((path) => path.startsWith(`${BUNDLE_ROOT}/`))).toBe(true)
    expect(host.reads).not.toContain(`${BUNDLE_ROOT}/secret.txt`)
  })

  it('refuses every path the allowlist does not name before touching the host', async () => {
    const host = bundleHost()
    const reader = createCompanionAssetReader(host, BUNDLE_ROOT)
    for (const path of [
      'assets/../companion/index.html',
      'assets/sub/app.js',
      'assets/..',
      'assets/.env',
      'assets/app.txt',
      'companion/other.html',
      'secret.txt',
      '',
    ]) {
      expect(await reader.read(path), path).toBeUndefined()
    }
    expect(host.reads).toEqual([])
    expect(await reader.read('companion/index.html')).toMatchObject({
      contentType: 'text/html; charset=utf-8',
    })
  })
})

describe('installApplicationCompanion sessions API', () => {
  it('pairs with the issued code and streams the snapshot first with the page header', async () => {
    const { companion, client, port, token } = await opened()
    expect(companion.settings.view().paired).toBe(true)
    expect(client.status).toBe(200)
    expect(client.pageId).not.toBe('')
    const snapshot = await firstSnapshot(client)
    expect(snapshot.rows.map((row) => row.handle)).toEqual([
      OTHER,
      EXTERNAL,
      LOCAL,
      REMOTE,
    ])

    const read = await send(port, 'GET', `/api/sessions?page=${client.pageId}`, {
      headers: bearer(token),
    })
    expect(read.status).toBe(200)
    expect(JSON.parse(read.body)).toEqual(snapshot)
    expect(
      (await send(port, 'GET', '/api/sessions?page=nope', { headers: bearer(token) }))
        .status,
    ).toBe(404)
    expect(
      (await send(port, 'GET', '/api/sessions', { headers: bearer(token) })).status,
    ).toBe(400)
    expect((await send(port, 'GET', '/api/events')).status).toBe(401)
  })

  it('pushes a fresh snapshot to the stream when the sources change', async () => {
    const { world, client } = await opened()
    world.sessions.set([])
    await until(() => client.frames.length >= 2, 'second snapshot frame')
    expect(client.frames[1]).toMatchObject({ event: 'snapshot' })
    expect(
      (client.frames[1]!.data as CompanionSnapshot).rows.map((row) => row.handle),
    ).toEqual([OTHER, EXTERNAL])
  })

  it('forwards select, resume, respond and message with the documented bodies', async () => {
    const { world, client, port, token } = await opened({ pending: true })
    const headers = bearer(token)
    const page = client.pageId
    const path = (verb: string, handle: string = EXTERNAL) =>
      `/api/sessions/${encodeURIComponent(handle)}/${verb}`

    expect(
      (await send(port, 'POST', path('resume'), { headers, body: { page } })).status,
    ).toBe(409)
    const selected = await send(port, 'POST', path('select'), { headers, body: { page } })
    expect(selected.status).toBe(200)
    expect(JSON.parse(selected.body)).toMatchObject({
      handle: EXTERNAL,
      status: 'loading',
    })
    await until(
      () => client.frames.some((frame) => frame.event === 'transcript'),
      'transcript',
    )
    const transcript = client.frames.find((frame) => frame.event === 'transcript')!
      .data as {
      pending?: { revision: number }
    }
    expect(transcript).toMatchObject({ handle: EXTERNAL, status: 'ready' })

    const resumed = await send(port, 'POST', path('resume'), { headers, body: { page } })
    expect(resumed.status).toBe(200)
    expect(JSON.parse(resumed.body)).toMatchObject({ handle: EXTERNAL })

    await until(
      () => transcript.pending !== undefined || client.frames.length > 2,
      'pending',
    )
    const latest = [...client.frames]
      .reverse()
      .find((frame) => frame.event === 'transcript')!.data as {
      pending?: { revision: number }
    }
    const pendingRevision = latest.pending?.revision ?? 1
    const responded = await send(port, 'POST', path('respond'), {
      headers,
      body: { page, handle: EXTERNAL, pendingRevision, optionOrdinal: 1 },
    })
    expect(responded.status).toBe(200)
    expect(JSON.parse(responded.body)).toMatchObject({ outcome: 'accepted' })
    expect(world.responded).toHaveLength(1)

    const messaged = await send(port, 'POST', path('message'), {
      headers,
      body: { page, handle: EXTERNAL, message: '  ship it  ' },
    })
    expect(messaged.status).toBe(200)
    expect(JSON.parse(messaged.body)).toMatchObject({ outcome: 'accepted' })
    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toMatchObject({ message: 'ship it' })
  })

  it('answers 400 for a malformed body, 404 for a closed page and decodes the handle', async () => {
    const { client, port, token } = await opened()
    const headers = bearer(token)
    const page = client.pageId
    const select = `/api/sessions/${encodeURIComponent(EXTERNAL)}/select`
    const cases: { path: string; body?: unknown; raw?: string; status: number }[] = [
      { path: select, raw: '{not json', status: 400 },
      { path: select, body: { page, extra: 1 }, status: 400 },
      { path: select, body: { page: 7 }, status: 400 },
      { path: select, body: { page: 'nope' }, status: 404 },
      {
        path: `/api/sessions/${encodeURIComponent(EXTERNAL)}/respond`,
        body: { page, handle: OTHER, pendingRevision: 1, optionOrdinal: 1 },
        status: 400,
      },
      {
        path: `/api/sessions/${encodeURIComponent(EXTERNAL)}/respond`,
        body: { page, handle: EXTERNAL, pendingRevision: 1 },
        status: 400,
      },
      {
        path: `/api/sessions/${encodeURIComponent(EXTERNAL)}/message`,
        body: { page, handle: EXTERNAL, message: '   ' },
        status: 400,
      },
      {
        path: `/api/sessions/${encodeURIComponent(EXTERNAL)}/message`,
        body: { page, handle: EXTERNAL, message: 'x'.repeat(8_001) },
        status: 400,
      },
      {
        path: `/api/sessions/${encodeURIComponent(EXTERNAL)}/message`,
        body: { page, handle: EXTERNAL, message: 'hello' },
        status: 409,
      },
    ]
    for (const item of cases) {
      const reply = await send(port, 'POST', item.path, {
        headers,
        ...(item.raw === undefined ? { body: item.body } : { raw: item.raw }),
      })
      expect(reply.status, JSON.stringify(item)).toBe(item.status)
      expect(JSON.parse(reply.body)).toHaveProperty('error')
    }
    const encoded = await send(port, 'POST', '/api/sessions/local%2Dsession/select', {
      headers,
      body: { page },
    })
    expect(encoded.status).toBe(200)
    expect(JSON.parse(encoded.body)).toMatchObject({ handle: LOCAL })
  })

  it('releases every lease when the stream socket closes', async () => {
    const { world, companion, client, port, token } = await opened()
    await send(port, 'POST', `/api/sessions/${encodeURIComponent(EXTERNAL)}/select`, {
      headers: bearer(token),
      body: { page: client.pageId },
    })
    await world.settle()
    expect(world.transcripts.openStreams).toBe(1)

    client.close()
    await until(
      () => companion.server.openStreams === 0 && companion.sessions.openPages === 0,
      'stream and page release',
    )
    expect(world.sessions.listenerCount()).toBe(0)
    expect(world.ptys.listenerCount()).toBe(0)
    expect(world.cities.listenerCount()).toBe(0)
    expect(world.transcripts.openStreams).toBe(0)
    // Push keeps the one actionable subscription; the page held none.
    expect(world.actionableListeners()).toBe(1)
  })

  it('closes every stream with revoked and refuses the old bearer afterwards', async () => {
    const { companion, client, port, token } = await opened()
    await companion.settings.revokePairing()
    await until(
      () => client.frames.some((frame) => frame.event === 'closed'),
      'closed frame',
    )
    expect(client.frames.at(-1)).toEqual({ event: 'closed', data: { reason: 'revoked' } })
    await client.closed
    expect(companion.sessions.openPages).toBe(0)
    expect(companion.server.listening).toBe(true)
    expect(
      (await send(port, 'GET', '/api/sessions?page=x', { headers: bearer(token) }))
        .status,
    ).toBe(401)
  })
})

describe('installApplicationCompanion push and disposal', () => {
  it('pushes once to the declared sink for an appearance while away', async () => {
    const { companion, world, pushed } = await harness()
    await companion.settings.save({
      enabled: false,
      port: 47811,
      push: { url: 'https://ntfy.example/hvir' },
    })
    expect(world.actionable.snapshot().away).toBe(true)

    world.actionable.setExternal([externalEntry])
    await until(() => pushed.length === 1, 'one push')
    world.actionable.setExternal([{ ...externalEntry, kind: 'bell' }])
    await world.settle()
    expect(pushed).toEqual(['https://ntfy.example/hvir'])
  })

  it('keeps the foreign session key out of push diagnostics', async () => {
    const { world, diagnostics } = await harness()
    expect(world.actionable.snapshot().away).toBe(true)

    world.actionable.setExternal([externalEntry])
    await until(
      () => diagnostics.some((diagnostic) => diagnostic.kind === 'push-outcome'),
      'a push outcome with no sink declared',
    )
    expect(diagnostics).toContainEqual({
      kind: 'push-outcome',
      outcome: {
        source: 'external',
        kind: 'ready',
        result: { outcome: 'skipped', reason: 'no-sink' },
      },
    })
    expect(JSON.stringify(diagnostics)).not.toContain('gc-1')
  })

  it('disposes in order: push, pages say shutdown, then the port is free', async () => {
    const { companion, world, client, port, owned, dispose } = await opened()
    expect(owned).toContain('Companion')
    await dispose()
    await client.closed
    expect(client.frames.at(-1)).toEqual({
      event: 'closed',
      data: { reason: 'shutdown' },
    })
    expect(companion.server.listening).toBe(false)
    expect(companion.sessions.openPages).toBe(0)
    expect(world.sessions.listenerCount()).toBe(0)
    expect(world.actionableListeners()).toBe(0)
    await expect(send(port, 'GET', '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('keeps the saved configuration across a reload', async () => {
    const store = memoryFile()
    const first = await harness({ store })
    await first.companion.settings.save({ enabled: true, port: 50_123 })
    await first.dispose()
    const second = await harness({ store })
    expect(second.companion.settings.view()).toMatchObject({
      enabled: true,
      port: 50_123,
    })
  })
})
