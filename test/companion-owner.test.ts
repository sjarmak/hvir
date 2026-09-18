import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

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

import { installApplicationCompanionSettings } from '../src/main/companion/companion-owner'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath, type CompanionConfigView } from '../src/shared'

describe('installApplicationCompanionSettings', () => {
  it('owns the settings on the runtime, publishes changes, and flushes on dispose', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-companion-owner-'))
    const host = new LocalHost()
    await host.connect()
    onTestFinished(async () => {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    })
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
    const file = localPath(join(directory, 'companion.json'))

    const settings = await installApplicationCompanionSettings(
      runtime,
      host,
      file,
      (view) => published.push(view),
    )
    expect(owned.map((entry) => entry.label)).toEqual(['Companion settings'])
    expect(settings.view()).toMatchObject({ enabled: false, port: 47811, paired: false })

    await settings.save({ enabled: true, port: 47811 })
    expect(published).toEqual([expect.objectContaining({ enabled: true })])
    await owned[0]!.dispose()

    const reloaded = await installApplicationCompanionSettings(
      runtime,
      host,
      file,
      () => {},
    )
    expect(reloaded.view().enabled).toBe(true)
  })
})
