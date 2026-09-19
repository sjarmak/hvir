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

import { localPath, type CompanionSnapshot } from '../src/shared'
import {
  LOCAL,
  OTHER,
  bearer,
  memoryFile,
  opened,
  releaseCompanionOwnerFixtures,
  send,
  until,
} from './companion-owner-fixture'
import { livePty, localRoot } from './companion-sessions-fixture'

afterEach(releaseCompanionOwnerFixtures)

describe('installApplicationCompanion terminal mirror', () => {
  it('POST input answers 403, 409, 404 and 200 in order and forwards terminal frames over SSE', async () => {
    const { world, companion, client, port, token } = await opened()
    const headers = bearer(token)
    const page = client.pageId
    const input = (handle: string) => `/api/sessions/${encodeURIComponent(handle)}/input`
    world.ptys.set([livePty('local-session', localRoot)])
    await until(
      () =>
        client.frames.some(
          (frame) =>
            frame.event === 'snapshot' &&
            (frame.data as CompanionSnapshot).rows.some(
              (row) => row.handle === LOCAL && row.canMirror,
            ),
        ),
      'a mirrorable local row',
    )

    const selected = await send(port, 'POST', input(LOCAL).replace('/input', '/select'), {
      headers,
      body: { page },
    })
    expect(selected.status).toBe(200)
    await until(() => client.frames.some((frame) => frame.event === 'terminal'), 'opened')
    expect(client.frames.find((frame) => frame.event === 'terminal')).toEqual({
      event: 'terminal',
      data: { type: 'opened', handle: LOCAL, cols: 132, rows: 43, tail: '\u001b[2J$ ' },
    })
    const lease = world.mirrors.leases[0]!
    lease.handlers.onData('permission? [y/n] ')
    const terminalFrames = () =>
      client.frames
        .filter((frame) => frame.event === 'terminal')
        .map((frame) => frame.data)
    await until(() => terminalFrames().length >= 2, 'output frame')
    expect(terminalFrames()[1]).toEqual({
      type: 'output',
      handle: LOCAL,
      data: 'permission? [y/n] ',
    })

    const disallowed = await send(port, 'POST', input(LOCAL), {
      headers,
      body: { page, data: 'y\r' },
    })
    expect(disallowed.status).toBe(403)
    expect(JSON.parse(disallowed.body)).toEqual({
      error: 'Typing from the Companion is off in Settings',
    })
    expect(lease.writes).toEqual([])

    // The same enabled/port keeps the listener where it is; only typing changes.
    await companion.settings.save({
      enabled: true,
      port: companion.settings.view().port,
      mirrorInputAllowed: true,
    })
    const noMirror = await send(port, 'POST', input(OTHER), {
      headers,
      body: { page, data: 'y\r' },
    })
    expect(noMirror.status).toBe(409)
    expect(JSON.parse(noMirror.body)).toEqual({
      error: 'Companion page holds no mirror for this row',
    })
    for (const body of [
      { page },
      { page, data: '' },
      { page, data: 'x'.repeat(4097) },
      { page, data: 'y', handle: LOCAL },
      { page, data: 7 },
    ]) {
      expect(
        (await send(port, 'POST', input(LOCAL), { headers, body })).status,
        JSON.stringify(body).slice(0, 40),
      ).toBe(400)
    }
    expect(
      (
        await send(port, 'POST', input(LOCAL), {
          headers,
          body: { page: 'nope', data: 'y' },
        })
      ).status,
    ).toBe(404)
    expect(lease.writes).toEqual([])

    const accepted = await send(port, 'POST', input(LOCAL), {
      headers,
      body: { page, data: 'y\r' },
    })
    expect(accepted.status).toBe(200)
    expect(JSON.parse(accepted.body)).toEqual({ outcome: 'accepted' })
    expect(lease.writes).toEqual(['y\r'])

    lease.refuse = 'ended'
    const ended = await send(port, 'POST', input(LOCAL), {
      headers,
      body: { page, data: '\u0003' },
    })
    expect(ended.status).toBe(409)
    expect(JSON.parse(ended.body)).toEqual({
      error: 'The mirrored terminal ended or changed',
    })
    await until(
      () =>
        client.frames.some(
          (frame) =>
            frame.event === 'terminal' &&
            (frame.data as { type: string }).type === 'ended',
        ),
      'ended frame',
    )
    expect(client.frames.at(-1)).toEqual({
      event: 'terminal',
      data: { type: 'ended', handle: LOCAL, reason: 'exited' },
    })
    expect(lease.writes).toEqual(['y\r'])
    expect(
      (await send(port, 'POST', input(LOCAL), { headers, body: { page, data: 'y' } }))
        .status,
    ).toBe(409)
    expect(JSON.stringify(world.mirrors.leases.map((l) => l.writes))).not.toContain(
      'permission?',
    )
  })

  it('input answers 403 until the setting is saved true, then 200, and the file carries the flag', async () => {
    const store = memoryFile()
    const { world, companion, client, port, token } = await opened({ store })
    const headers = bearer(token)
    const page = client.pageId
    const input = `/api/sessions/${encodeURIComponent(LOCAL)}/input`
    const stored = async (): Promise<boolean> => {
      await companion.settings.flush()
      const text = await store.readTextFile(localPath('/companion.json'))
      return (JSON.parse(text) as { mirrorInputAllowed: boolean }).mirrorInputAllowed
    }
    world.ptys.set([livePty('local-session', localRoot)])
    await until(
      () =>
        client.frames.some(
          (frame) =>
            frame.event === 'snapshot' &&
            (frame.data as CompanionSnapshot).rows.some(
              (row) => row.handle === LOCAL && row.canMirror,
            ),
        ),
      'a mirrorable local row',
    )
    const select = `/api/sessions/${encodeURIComponent(LOCAL)}/select`
    expect((await send(port, 'POST', select, { headers, body: { page } })).status).toBe(
      200,
    )
    await until(() => world.mirrors.leases.length === 1, 'lease')
    const lease = world.mirrors.leases[0]!
    const port_ = companion.settings.view().port

    expect(await stored()).toBe(false)
    expect(
      (await send(port, 'POST', input, { headers, body: { page, data: '\r' } })).status,
    ).toBe(403)

    await companion.settings.save({
      enabled: true,
      port: port_,
      mirrorInputAllowed: true,
    })
    expect(await stored()).toBe(true)
    expect(companion.settings.view().mirrorInputAllowed).toBe(true)
    expect(
      (await send(port, 'POST', input, { headers, body: { page, data: '\r' } })).status,
    ).toBe(200)
    expect(lease.writes).toEqual(['\r'])

    await companion.settings.save({
      enabled: true,
      port: port_,
      mirrorInputAllowed: false,
    })
    expect(await stored()).toBe(false)
    expect(
      (await send(port, 'POST', input, { headers, body: { page, data: 'y' } })).status,
    ).toBe(403)
    expect(lease.writes).toEqual(['\r'])
  })

  it('input after the PTY exited answers 409 once the page holds the ended frame', async () => {
    const { world, companion, client, port, token } = await opened()
    const headers = bearer(token)
    const page = client.pageId
    world.ptys.set([livePty('local-session', localRoot)])
    await companion.settings.save({
      enabled: true,
      port: companion.settings.view().port,
      mirrorInputAllowed: true,
    })
    await until(
      () =>
        client.frames.some(
          (frame) =>
            frame.event === 'snapshot' &&
            (frame.data as CompanionSnapshot).rows.some(
              (row) => row.handle === LOCAL && row.canMirror,
            ),
        ),
      'a mirrorable local row',
    )
    const select = `/api/sessions/${encodeURIComponent(LOCAL)}/select`
    expect((await send(port, 'POST', select, { headers, body: { page } })).status).toBe(
      200,
    )
    await until(() => world.mirrors.leases.length === 1, 'lease')
    const lease = world.mirrors.leases[0]!

    lease.exit({ exitCode: 0, signal: undefined })
    await until(
      () =>
        client.frames.some(
          (frame) =>
            frame.event === 'terminal' &&
            (frame.data as { type: string }).type === 'ended',
        ),
      'ended frame',
    )
    expect(client.frames.at(-1)).toEqual({
      event: 'terminal',
      data: { type: 'ended', handle: LOCAL, reason: 'exited' },
    })

    const refused = await send(
      port,
      'POST',
      `/api/sessions/${encodeURIComponent(LOCAL)}/input`,
      {
        headers,
        body: { page, data: '\r' },
      },
    )
    expect(refused.status).toBe(409)
    expect(JSON.parse(refused.body)).toEqual({
      error: 'Companion page holds no mirror for this row',
    })
    expect(lease.writes).toEqual([])
  })

  it('revocation sends terminal ended revoked before closed', async () => {
    const { world, companion, client, port, token } = await opened()
    world.ptys.set([livePty('local-session', localRoot)])
    await until(() => client.frames.length >= 2, 'live snapshot')
    await send(port, 'POST', `/api/sessions/${encodeURIComponent(LOCAL)}/select`, {
      headers: bearer(token),
      body: { page: client.pageId },
    })
    await until(() => client.frames.some((frame) => frame.event === 'terminal'), 'opened')

    await companion.settings.revokePairing()
    await client.closed
    expect(client.frames.slice(-2)).toEqual([
      {
        event: 'terminal',
        data: { type: 'ended', handle: LOCAL, reason: 'revoked' },
      },
      { event: 'closed', data: { reason: 'revoked' } },
    ])
    expect(world.mirrors.leases[0]!.released).toBe(true)
  })
})
