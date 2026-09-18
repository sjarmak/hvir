/**
 * The Companion scenario (ADR-049, ADR-050) in the real Electron smoke app:
 * enable the loopback listener, pair over HTTP, prove the served page resolves
 * every asset it names and that the emulator's WebAssembly module is served as
 * one, read the first Sessions snapshot over SSE, then prove that closing the
 * socket releases every lease and that revoking the pairing refuses the bearer
 * that opened it.
 */
import { join } from 'node:path'

import {
  asHarnessProfileId,
  localPath,
  type HarnessProviderId,
  type HostPath,
  type TerminalRecoverySession,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import { waitFor } from './attention-away-probe'
import { expectStatus, openEvents, send } from './companion-http'
import type { SmokeCompanion } from './companion-smoke'

export const COMPANION_SMOKE_SESSION_ID = 'companion-smoke-session'
const COMPANION_SMOKE_TITLE = 'Companion smoke session'
const STEP_TIMEOUT_MS = 10_000

export interface CompanionScenarioOptions {
  readonly companion: SmokeCompanion
  /** Lists the built renderer bundle, so the wasm module is found by its hashed name. */
  readonly bundle: Pick<ProjectHost, 'readdir'>
  readonly root: HostPath
  readonly providerId: HarnessProviderId
  readonly addRetained: (root: HostPath, session: TerminalRecoverySession) => void
  /** Listeners on the smoke session source; a closed page leaves none of its own. */
  readonly sourceListeners: () => number
}

export async function verifyCompanionScenario(
  options: CompanionScenarioOptions,
): Promise<string> {
  const { companion, sourceListeners } = options
  const { settings, server, sessions } = companion
  options.addRetained(options.root, retained(options.root, options.providerId))
  if (server.listening) throw new Error('Companion listener was open before enable')

  await settings.save({ enabled: true, port: requestedPort(), mirrorInputAllowed: false })
  await waitFor(() => settings.view().status.listening, STEP_TIMEOUT_MS, 'listener open')
  const port = settings.view().status.port
  if (port === undefined || server.port !== port) {
    throw new Error(`Companion status port ${port} disagrees with bound ${server.port}`)
  }
  const code = settings.issuePairing().pairing?.code
  if (code === undefined) throw new Error('Companion issued no pairing code')
  const paired = await send(port, 'POST', '/pair', { body: { code } })
  expectStatus(paired, 200, 'POST /pair')
  const token = (JSON.parse(paired.body) as { token: string }).token
  const bearer = { authorization: `Bearer ${token}` }

  const assets = await verifyServedPage(port)
  const wasm = await verifyServedWasm(port, options.bundle, companion.rendererRoot)
  const listenersBefore = sourceListeners()
  const stream = await openEvents(port, bearer)
  const snapshot = await stream.firstSnapshot()
  const row = snapshot.rows.find(
    (candidate) => candidate.handle === COMPANION_SMOKE_SESSION_ID,
  )
  if (row === undefined || row.title !== COMPANION_SMOKE_TITLE) {
    throw new Error(
      `Companion snapshot lacks the seeded row: ${JSON.stringify(snapshot.rows)}`,
    )
  }
  const read = await send(port, 'GET', `/api/sessions?page=${stream.pageId}`, {
    headers: bearer,
  })
  expectStatus(read, 200, 'GET /api/sessions')
  if (sessions.openPages !== 1 || server.openStreams !== 1) {
    throw new Error(
      `Expected one open page and stream, saw ${sessions.openPages}/${server.openStreams}`,
    )
  }
  stream.close()
  await waitFor(
    () => server.openStreams === 0 && sessions.openPages === 0,
    STEP_TIMEOUT_MS,
    'page release after socket close',
  )
  await waitFor(
    () => sourceListeners() === listenersBefore,
    STEP_TIMEOUT_MS,
    'source release',
  )

  await settings.revokePairing()
  const refused = await send(port, 'GET', '/api/sessions?page=x', { headers: bearer })
  expectStatus(refused, 401, 'GET /api/sessions after revoke')
  const unexpected = companion.diagnostics.filter(
    (diagnostic) =>
      diagnostic.kind === 'listener-failed' || diagnostic.kind === 'request-failure',
  )
  if (unexpected.length > 0)
    throw new Error(`Companion diagnostics: ${JSON.stringify(unexpected)}`)
  await settings.save({
    enabled: false,
    port: settings.view().port,
    mirrorInputAllowed: false,
  })
  await waitFor(() => !server.listening, STEP_TIMEOUT_MS, 'listener close')
  return `port ${port}, ${assets} assets, ${wasm} served as wasm, ${snapshot.rows.length} rows, leases released, revoke refused`
}

function requestedPort(): number {
  const raw = process.env['HVIR_SMOKE_COMPANION_PORT']
  if (raw === undefined || raw === '') return 0
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`HVIR_SMOKE_COMPANION_PORT is not a port: ${raw}`)
  }
  return port
}

function retained(
  root: HostPath,
  providerId: HarnessProviderId,
): TerminalRecoverySession {
  return {
    id: COMPANION_SMOKE_SESSION_ID,
    providerId,
    profileId: asHarnessProfileId('plain-shell-default'),
    launchRevision: 1,
    recoverySkipCount: 0,
    hostId: root.hostId,
    cwd: root,
    title: COMPANION_SMOKE_TITLE,
    position: 0,
    active: true,
    updatedAt: Date.now(),
  }
}

/** GET / then every same-origin src and href the page names; each must be 200. */
async function verifyServedPage(port: number): Promise<number> {
  const index = await send(port, 'GET', '/')
  expectStatus(index, 200, 'GET /')
  if (!index.headers['content-type']?.startsWith('text/html')) {
    throw new Error(`GET / content type ${index.headers['content-type']}`)
  }
  const base = new URL(`http://127.0.0.1:${port}/`)
  const references = [...index.body.matchAll(/\b(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1]!, base))
    .filter((url) => url.origin === base.origin)
  if (references.length === 0) throw new Error('Served page names no asset')
  for (const url of references) {
    expectStatus(
      await send(port, 'GET', `${url.pathname}${url.search}`),
      200,
      `GET ${url.pathname}`,
    )
  }
  return references.length
}

/**
 * The page loads ghostty-web's module by a hashed name the HTML never lists,
 * so the bundle's one `.wasm` is found on disk and fetched by name: it must be
 * allowlisted and served with the media type WebAssembly streaming requires.
 */
async function verifyServedWasm(
  port: number,
  bundle: Pick<ProjectHost, 'readdir'>,
  rendererRoot: string,
): Promise<string> {
  const entries = await bundle.readdir(localPath(join(rendererRoot, 'assets')))
  const modules = entries
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.wasm'))
    .map((entry) => entry.name)
  if (modules.length !== 1) {
    throw new Error(`Expected one .wasm in the renderer bundle, found ${modules.length}`)
  }
  const name = modules[0]!
  const reply = await send(port, 'GET', `/assets/${name}`)
  expectStatus(reply, 200, `GET /assets/${name}`)
  if (reply.headers['content-type'] !== 'application/wasm') {
    throw new Error(`GET /assets/${name} content type ${reply.headers['content-type']}`)
  }
  return name
}
