import { isCompanionConfigSave } from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type CompanionIpcDeps = Pick<IpcDeps, 'companion'>

/**
 * Companion settings over IPC (ADR-049). Every answer is the settings view,
 * which never carries the credential or the push token; the token travels
 * only inward, as a write-only field of a save.
 */
export function registerCompanionIpc(ipc: IpcRegistrar, deps: CompanionIpcDeps): void {
  ipc.handle('companion:config', (_request, context) => {
    context.owner()
    return deps.companion.view()
  })
  ipc.handle('companion:config-save', (request, context) => {
    context.owner()
    if (!isCompanionConfigSave(request)) {
      throw new Error('Rejected malformed Companion settings save')
    }
    return deps.companion.save(request)
  })
  ipc.handle('companion:pairing-issue', (_request, context) => {
    context.owner()
    return deps.companion.issuePairing()
  })
  ipc.handle('companion:pairing-revoke', (_request, context) => {
    context.owner()
    return deps.companion.revokePairing()
  })
}
