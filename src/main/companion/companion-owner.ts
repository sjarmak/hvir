import { safeStorage } from 'electron'

import type { CompanionConfigView, HostPath } from '../../shared'
import type { WorkbenchRuntime } from '../workbench-runtime'
import {
  CompanionConfigStore,
  type CompanionConfigDiagnostic,
  type CompanionSecretStorage,
  type CompanionStoreFile,
} from './companion-config-store'
import { CompanionSettings } from './companion-settings'

export interface CompanionSettingsInstallOptions {
  /** Defaults to Electron's safeStorage; tests inject a cipher of their own. */
  readonly secrets?: CompanionSecretStorage
  readonly onDiagnostic?: (diagnostic: CompanionConfigDiagnostic) => void
}

/**
 * Own the Companion settings on the workbench runtime (ADR-049): load
 * `companion.json`, expose the view to Settings, publish every change to the
 * windows, and flush the file when the runtime winds down. The loopback
 * listener is a separate owner that drives `setStatus` on what this returns.
 */
export async function installApplicationCompanionSettings(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  host: CompanionStoreFile,
  file: HostPath,
  publish: (view: CompanionConfigView) => void,
  options: CompanionSettingsInstallOptions = {},
): Promise<CompanionSettings> {
  const store = await CompanionConfigStore.load(host, file, {
    secrets: options.secrets ?? safeStorage,
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  })
  const settings = new CompanionSettings({ store })
  settings.observe(publish)
  return runtime.own('Companion settings', settings, (owned) => owned.flush())
}
