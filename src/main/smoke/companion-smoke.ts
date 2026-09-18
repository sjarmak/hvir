import { localPath } from '../../shared'
import {
  CompanionConfigStore,
  type CompanionStoreFile,
} from '../companion/companion-config-store'
import { CompanionSettings } from '../companion/companion-settings'

/**
 * The production Companion settings over a file that exists only in memory,
 * with no OS cipher: a scenario can read and save the view exactly as the
 * app does, while nothing touches the disk or the keychain of the machine
 * running it. No listener runs here; status stays `{ listening: false }`.
 */
export async function createSmokeCompanionSettings(): Promise<CompanionSettings> {
  const store = await CompanionConfigStore.load(
    memoryFile(),
    localPath('/companion.json'),
    {
      secrets: {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('smoke: no secret storage')
        },
        decryptString: () => {
          throw new Error('smoke: no secret storage')
        },
      },
    },
  )
  return new CompanionSettings({ store })
}

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
