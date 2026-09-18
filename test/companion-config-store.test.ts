import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import {
  CompanionConfigStore,
  type CompanionConfigDiagnostic,
  type CompanionSecretStorage,
} from '../src/main/companion/companion-config-store'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath, type HostPath } from '../src/shared'

const TOKEN = 'ntfy-secret-token-value'

/** A reversible cipher whose output never contains the plain text. */
function fakeSecrets(available = true): CompanionSecretStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) =>
      Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)),
    decryptString: (encrypted) =>
      Buffer.from(encrypted.map((b) => b ^ 0x5a)).toString('utf8'),
  }
}

async function scratch(): Promise<{ host: LocalHost; file: HostPath; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-companion-store-'))
  const host = new LocalHost()
  await host.connect()
  onTestFinished(async () => {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const path = join(directory, 'companion.json')
  return { host, file: localPath(path), path }
}

async function load(
  world: { host: LocalHost; file: HostPath },
  secrets = fakeSecrets(),
  onDiagnostic = vi.fn<(diagnostic: CompanionConfigDiagnostic) => void>(),
) {
  const store = await CompanionConfigStore.load(world.host, world.file, {
    secrets,
    onDiagnostic,
  })
  return { store, onDiagnostic }
}

describe('CompanionConfigStore', () => {
  it('starts disabled on the default port when nothing is stored', async () => {
    const { store, onDiagnostic } = await load(await scratch())
    expect(store.config()).toEqual({ enabled: false, port: 47811 })
    expect(store.pushToken()).toBeUndefined()
    expect(onDiagnostic).not.toHaveBeenCalled()
  })

  it('round-trips a save and keeps the push token encrypted on disk', async () => {
    const world = await scratch()
    const { store } = await load(world)
    await expect(
      store.save({
        enabled: true,
        port: 50_000,
        push: { url: 'https://ntfy.example/hvir', token: TOKEN },
      }),
    ).resolves.toEqual({ outcome: 'saved' })
    await store.flush()

    const text = await readFile(world.path, 'utf8')
    expect(text).not.toContain(TOKEN)
    expect(JSON.parse(text)).toMatchObject({ version: 1, enabled: true, port: 50_000 })

    const reloaded = await load(world)
    expect(reloaded.store.config()).toMatchObject({
      enabled: true,
      port: 50_000,
      push: { url: 'https://ntfy.example/hvir' },
    })
    expect(reloaded.store.config().push?.tokenCiphertext).toEqual(expect.any(String))
    expect(reloaded.store.pushToken()).toBe(TOKEN)
  })

  it('falls back to defaults with a diagnostic on a version it does not know', async () => {
    const world = await scratch()
    await writeFile(world.path, JSON.stringify({ version: 2, enabled: true, port: 1 }))
    const { store, onDiagnostic } = await load(world)
    expect(store.config()).toEqual({ enabled: false, port: 47811 })
    expect(onDiagnostic).toHaveBeenCalledWith({ kind: 'version-mismatch', found: 2 })
  })

  it('falls back to defaults with a diagnostic on an unreadable file', async () => {
    const world = await scratch()
    await writeFile(world.path, '{not json')
    const { store, onDiagnostic } = await load(world)
    expect(store.config()).toEqual({ enabled: false, port: 47811 })
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unreadable' }),
    )
  })

  it('refuses the token but keeps the url when no encryption is available', async () => {
    const { store } = await load(await scratch(), fakeSecrets(false))
    await expect(
      store.save({
        enabled: false,
        port: 47811,
        push: { url: 'https://x.example', token: TOKEN },
      }),
    ).resolves.toEqual({ outcome: 'token-rejected', reason: 'encryption-unavailable' })
    expect(store.config().push).toEqual({ url: 'https://x.example' })
    expect(store.pushToken()).toBeUndefined()
  })

  it('keeps the token when the save omits it and clears it on an empty string', async () => {
    const { store } = await load(await scratch())
    await store.save({
      enabled: true,
      port: 47811,
      push: { url: 'https://a.example', token: TOKEN },
    })
    await store.save({ enabled: true, port: 47811, push: { url: 'https://b.example' } })
    expect(store.config().push?.url).toBe('https://b.example')
    expect(store.pushToken()).toBe(TOKEN)

    await store.save({
      enabled: true,
      port: 47811,
      push: { url: 'https://b.example', token: '' },
    })
    expect(store.config().push).toEqual({ url: 'https://b.example' })
    expect(store.pushToken()).toBeUndefined()

    await store.save({ enabled: true, port: 47811 })
    expect(store.config().push).toBeUndefined()
  })

  it('persists the credential hash separately from the settings', async () => {
    const world = await scratch()
    const { store } = await load(world)
    await store.setCredential({ hash: 'ab'.repeat(32), issuedAt: 1_700_000_000_000 })
    await store.save({ enabled: true, port: 47811 })
    const reloaded = await load(world)
    expect(reloaded.store.config().credential).toEqual({
      hash: 'ab'.repeat(32),
      issuedAt: 1_700_000_000_000,
    })
    await reloaded.store.clearCredential()
    expect((await load(world)).store.config().credential).toBeUndefined()
  })

  it('reports a token it can no longer decrypt instead of returning garbage', async () => {
    const world = await scratch()
    const first = await load(world)
    await first.store.save({
      enabled: true,
      port: 47811,
      push: { url: 'https://a.example', token: TOKEN },
    })
    await first.store.flush()
    const broken: CompanionSecretStorage = {
      ...fakeSecrets(),
      decryptString: () => {
        throw new Error('keychain changed')
      },
    }
    const { store, onDiagnostic } = await load(world, broken)
    expect(store.pushToken()).toBeUndefined()
    expect(onDiagnostic).toHaveBeenCalledWith({
      kind: 'token-undecryptable',
      message: 'keychain changed',
    })
  })
})
