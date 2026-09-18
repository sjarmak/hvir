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

import { createCompanionAssetReader } from '../src/main/companion/companion-assets'
import type { CompanionSnapshot } from '../src/shared'
import {
  BUNDLE_ROOT,
  EXTERNAL,
  LOCAL,
  OTHER,
  REMOTE,
  bearer,
  bundleHost,
  companionOwnerCleanups,
  enable,
  externalEntry,
  firstSnapshot,
  harness,
  memoryFile,
  opened,
  releaseCompanionOwnerFixtures,
  send,
  until,
} from './companion-owner-fixture'

afterEach(releaseCompanionOwnerFixtures)

describe('installApplicationCompanion listener lifecycle', () => {
  it('listens nowhere while disabled and follows enable, port change and disable', async () => {
    const { companion, published } = await harness()
    expect(companion.server.listening).toBe(false)
    expect(companion.settings.view().status).toEqual({ listening: false })

    const first = await enable(companion)
    expect(companion.server.port).toBe(first)
    expect(published.at(-1)?.status).toEqual({ listening: true, port: first })
    expect((await send(first, 'GET', '/')).status).toBe(200)

    await companion.settings.save({
      enabled: true,
      port: first,
      mirrorInputAllowed: false,
    })
    await until(
      () => companion.settings.view().status.port === first && companion.server.listening,
      'reopen on the named port',
    )
    expect((await send(first, 'GET', '/')).status).toBe(200)

    await companion.settings.save({
      enabled: false,
      port: first,
      mirrorInputAllowed: false,
    })
    await until(() => !companion.settings.view().status.listening, 'listener to close')
    expect(companion.server.listening).toBe(false)
    await expect(send(first, 'GET', '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('reports a port it cannot bind as a status and a diagnostic, never a rejection', async () => {
    const { companion, diagnostics } = await harness()
    const blocker = createNetServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    companionOwnerCleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())))
    const taken = (blocker.address() as AddressInfo).port

    await companion.settings.save({
      enabled: true,
      port: taken,
      mirrorInputAllowed: false,
    })
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
    const wasm = await send(port, 'GET', '/assets/ghostty-vt-abc123.wasm')
    expect(wasm.status).toBe(200)
    expect(wasm.headers['content-type']).toBe('application/wasm')

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
      mirrorInputAllowed: false,
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
    await first.companion.settings.save({
      enabled: true,
      port: 50_123,
      mirrorInputAllowed: false,
    })
    await first.dispose()
    const second = await harness({ store })
    expect(second.companion.settings.view()).toMatchObject({
      enabled: true,
      port: 50_123,
    })
  })
})
