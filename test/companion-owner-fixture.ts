import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'

import { expect } from 'vitest'

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

export const EXTERNAL = asSessionsTerminalHandle('sessions-external-0001')
export const OTHER = asSessionsTerminalHandle('sessions-external-0002')
export const LOCAL = asSessionsTerminalHandle('local-session')
export const REMOTE = asSessionsTerminalHandle('remote-session')
export const BUNDLE_ROOT = '/bundle'

export const companionOwnerCleanups: (() => Promise<void> | void)[] = []

/** Register as the test file's afterEach: disposes harnesses and closes SSE clients in reverse order. */
export async function releaseCompanionOwnerFixtures(): Promise<void> {
  for (const cleanup of companionOwnerCleanups.splice(0).reverse()) await cleanup()
}

export function memoryFile(): CompanionStoreFile {
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

export function bundleHost(): {
  readFile: (path: HostPath) => Promise<Buffer>
  reads: string[]
} {
  const files = new Map<string, string>([
    [`${BUNDLE_ROOT}/companion/index.html`, '<!doctype html><title>Companion</title>'],
    [`${BUNDLE_ROOT}/assets/app-1.js`, 'console.log(1)'],
    [`${BUNDLE_ROOT}/assets/app-1.css`, 'body{}'],
    [`${BUNDLE_ROOT}/assets/app-1.js.map`, '{"version":3}'],
    [`${BUNDLE_ROOT}/assets/ghostty-vt-abc123.wasm`, '\0asm'],
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

export const externalEntry: MainActionableEntry = {
  key: 'gas-city local gc-1',
  kind: 'ready',
  freshness: 'fresh',
  external: { sourceId: 'gas-city', hostId: asHostId('local'), key: 'gc-1' },
}

export interface Harness {
  readonly companion: ApplicationCompanion
  readonly world: ReturnType<typeof companionWorld>
  readonly published: CompanionConfigView[]
  readonly diagnostics: CompanionOwnerDiagnostic[]
  readonly pushed: string[]
  readonly host: ReturnType<typeof bundleHost>
  readonly owned: string[]
  readonly dispose: () => Promise<void>
}

export async function harness(
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
    mirrors: { attachMirror: world.mirrors.ports.attach },
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
  companionOwnerCleanups.push(dispose)
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

export async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

export async function enable(companion: ApplicationCompanion, port = 0): Promise<number> {
  await companion.settings.save({ enabled: true, port, mirrorInputAllowed: false })
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

export function send(
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

export function bearer(token: string): OutgoingHttpHeaders {
  return { authorization: `Bearer ${token}` }
}

export async function pair(companion: ApplicationCompanion, port: number): Promise<string> {
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

export interface EventsClient {
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

export function openEvents(port: number, token: string): Promise<EventsClient> {
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
      companionOwnerCleanups.push(() => client.close())
      resolve(client)
    })
    request.on('error', reject)
    request.end()
  })
}

export async function firstSnapshot(client: EventsClient): Promise<CompanionSnapshot> {
  await until(() => client.frames.length > 0, 'first frame')
  const frame = client.frames[0]!
  expect(frame.event).toBe('snapshot')
  return frame.data as CompanionSnapshot
}

export async function opened(
  options: { pending?: boolean; store?: CompanionStoreFile } = {},
): Promise<Harness & { port: number; token: string; client: EventsClient }> {
  const world = await harness(options)
  const port = await enable(world.companion)
  const token = await pair(world.companion, port)
  const client = await openEvents(port, token)
  await firstSnapshot(client)
  return { ...world, port, token, client }
}
