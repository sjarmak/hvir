import { shell } from 'electron'

import { ExtensionExternalLinks } from './external-link'

export function createElectronExternalLinks(): ExtensionExternalLinks {
  return new ExtensionExternalLinks((url) => shell.openExternal(url))
}
