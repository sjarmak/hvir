import { describe, expect, it, vi } from 'vitest'

import {
  CompanionConfigStore,
  type CompanionSecretStorage,
  type CompanionStoreFile,
} from '../src/main/companion/companion-config-store'
import { CompanionSettings } from '../src/main/companion/companion-settings'
import type { IpcInvokeContext, IpcRegistrar } from '../src/main/ipc/authority-router'
import { registerCompanionIpc } from '../src/main/ipc/features/companion'
import { localPath, type CompanionConfigView, type IpcInvokeChannel } from '../src/shared'

const FILE = localPath('/tmp/companion.json')

function memoryFile(): CompanionStoreFile & { text: () => string | undefined } {
  let text: string | undefined
  return {
    text: () => text,
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

function secrets(available = true): CompanionSecretStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
    decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
  }
}

async function harness(available = true) {
  const file = memoryFile()
  const store = await CompanionConfigStore.load(file, FILE, {
    secrets: secrets(available),
  })
  const settings = new CompanionSettings({ store, now: () => 1_700_000_000_000 })
  const seen: CompanionConfigView[] = []
  settings.observe((view) => seen.push(view))
  return { file, store, settings, seen }
}

describe('CompanionSettings', () => {
  it('starts disabled, unpaired and not listening, with no pairing code', async () => {
    const { settings } = await harness()
    expect(settings.view()).toEqual({
      enabled: false,
      port: 47811,
      paired: false,
      push: undefined,
      status: { listening: false },
    })
    expect('pairing' in settings.view()).toBe(false)
  })

  it('saves settings, reports the push token only as configured, and notifies', async () => {
    const { settings, seen, file } = await harness()
    const view = await settings.save({
      enabled: true,
      port: 50_000,
      push: { url: 'https://ntfy.example/hvir', token: 'secret-value' },
    })
    expect(view).toMatchObject({
      enabled: true,
      port: 50_000,
      push: { url: 'https://ntfy.example/hvir', tokenConfigured: true },
    })
    expect(JSON.stringify(view)).not.toContain('secret-value')
    expect(seen).toEqual([view])
    await settings.flush()
    expect(file.text()).not.toContain('secret-value')
  })

  it('keeps the url and fails loudly when the token cannot be encrypted', async () => {
    const { settings } = await harness(false)
    await expect(
      settings.save({
        enabled: false,
        port: 47811,
        push: { url: 'https://ntfy.example/hvir', token: 'secret-value' },
      }),
    ).rejects.toThrow(/encrypted/)
    expect(settings.view().push).toEqual({
      url: 'https://ntfy.example/hvir',
      tokenConfigured: false,
    })
  })

  it('issues a pairing code, pairs through the auth port, and revokes', async () => {
    const { settings, seen, store } = await harness()
    const revoked = vi.fn()
    settings.onRevoked(revoked)

    const issued = settings.issuePairing()
    expect(issued.pairing).toEqual({
      code: expect.stringMatching(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/) as string,
      expiresAt: 1_700_000_000_000 + 10 * 60_000,
    })
    expect(issued.paired).toBe(false)

    const token = settings.auth.exchange(issued.pairing!.code)
    expect(token).toEqual(expect.any(String))
    expect(settings.auth.verify(token!)).toBe(true)
    expect(settings.view()).toMatchObject({ paired: true })
    expect('pairing' in settings.view()).toBe(false)
    await settings.flush()
    expect(store.config().credential).toMatchObject({ issuedAt: 1_700_000_000_000 })

    const afterRevoke = await settings.revokePairing()
    expect(afterRevoke.paired).toBe(false)
    expect(settings.auth.verify(token!)).toBe(false)
    expect(revoked).toHaveBeenCalledTimes(1)
    expect(store.config().credential).toBeUndefined()
    expect(seen.map((view) => view.paired)).toEqual([false, true, false])
  })

  it('carries the listener status a later owner sets', async () => {
    const { settings, seen } = await harness()
    settings.setStatus({ listening: true, port: 47811 })
    expect(settings.view().status).toEqual({ listening: true, port: 47811 })
    settings.setStatus({ listening: false, error: 'EADDRINUSE' })
    expect(settings.view().status).toEqual({ listening: false, error: 'EADDRINUSE' })
    expect(seen).toHaveLength(2)
  })

  it('stops notifying a disposed observer', async () => {
    const { settings } = await harness()
    const listener = vi.fn()
    const dispose = settings.observe(listener)
    void dispose()
    settings.setStatus({ listening: true, port: 1 })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('registerCompanionIpc', () => {
  function registrar() {
    const handlers = new Map<
      IpcInvokeChannel,
      (request: unknown, context: IpcInvokeContext) => unknown
    >()
    const ipc = {
      authority: undefined,
      handle: (channel: IpcInvokeChannel, handler: unknown) => {
        handlers.set(
          channel,
          handler as (request: unknown, context: IpcInvokeContext) => unknown,
        )
      },
      handleSend: () => undefined,
    } as unknown as IpcRegistrar
    return { ipc, handlers }
  }

  async function wired() {
    const { settings } = await harness()
    const { ipc, handlers } = registrar()
    registerCompanionIpc(ipc, { companion: settings })
    const owner = vi.fn(() => ({ id: 'window-1' }))
    const context = { owner } as unknown as IpcInvokeContext
    const call = (channel: IpcInvokeChannel, request?: unknown) =>
      handlers.get(channel)!(request, context)
    return { settings, handlers, owner, call }
  }

  it('registers the four owner-scoped invokes and reads the owner on each', async () => {
    const { handlers, owner, call } = await wired()
    expect([...handlers.keys()].sort()).toEqual([
      'companion:config',
      'companion:config-save',
      'companion:pairing-issue',
      'companion:pairing-revoke',
    ])
    expect(call('companion:config')).toMatchObject({ enabled: false, port: 47811 })
    expect(call('companion:pairing-issue')).toMatchObject({
      pairing: {
        code: expect.any(String) as string,
        expiresAt: expect.any(Number) as number,
      },
    })
    await expect(call('companion:pairing-revoke')).resolves.toMatchObject({
      paired: false,
    })
    await expect(
      call('companion:config-save', { enabled: true, port: 47811 }),
    ).resolves.toMatchObject({ enabled: true })
    expect(owner).toHaveBeenCalledTimes(4)
  })

  it('rejects a save that is not a settings save', async () => {
    const { call, settings } = await wired()
    expect(() => call('companion:config-save', { enabled: true, port: 80 })).toThrow(
      /Companion settings/,
    )
    expect(settings.view().enabled).toBe(false)
  })
})
