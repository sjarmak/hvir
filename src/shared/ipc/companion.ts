import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type { CompanionConfigSave, CompanionConfigView } from '../companion-settings'

/**
 * Companion settings (ADR-049): read and save the configuration, issue and
 * revoke the pairing, and follow the listener status. Every answer is the
 * same view, which carries no credential and no push token.
 */
export const companionIpc = {
  invoke: {
    'companion:config': invoke<void, CompanionConfigView>(),
    'companion:config-save': invoke<CompanionConfigSave, CompanionConfigView>(),
    'companion:pairing-issue': invoke<void, CompanionConfigView>(),
    'companion:pairing-revoke': invoke<void, CompanionConfigView>(),
  },
  send: {},
  event: {
    'companion:status-changed': payload<CompanionConfigView>(),
  },
} satisfies IpcFeatureContract
