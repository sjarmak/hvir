import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { SmokeOwnedResourceEvidence } from './failure-evidence.mts'

/** What the smoke root still owns at a failure or cleanup checkpoint. */
export function smokeOwnedResourceEvidence(
  win: BrowserWindow | undefined,
  supervisor: PtySupervisor | undefined,
  watcherActive: boolean,
  rendererResources: RendererResourceScopes,
): SmokeOwnedResourceEvidence {
  let rendererGeneration: number | null = null
  if (win && !win.isDestroyed()) {
    try {
      rendererGeneration = rendererResources.currentOwner(win.webContents.id).generation
    } catch {
      // A revoked owner is represented by the closed null/false fields below.
    }
  }
  return {
    windowCount: win && !win.isDestroyed() ? 1 : 0,
    ptyCount: supervisor?.list().length ?? 0,
    watcherActive,
    rendererOwnerActive: rendererGeneration !== null,
    rendererGeneration,
  }
}
