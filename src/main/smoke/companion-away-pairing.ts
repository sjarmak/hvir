/**
 * What the Companion Away scenarios share (ADR-049, ADR-050, ADR-051): the
 * options the smoke runtime hands them, enabling and pairing the listener with
 * a recording Push sink, and the retained record that gives the measured
 * terminal its row and its Push title.
 */

import type { BrowserWindow } from 'electron'

import type { HostPath, TerminalRecoverySession } from '../../shared'
import type { ManagedPty } from '../pty/pty-contract'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { waitFor } from './attention-away-probe'
import type { SmokeAttention } from './attention-smoke'
import { expectStatus, send } from './companion-http'
import type { SmokeCompanion } from './companion-smoke'

export const SMOKE_PUSH_URL = 'https://push.invalid/hvir-smoke'
const LISTENER_TIMEOUT_MS = 10_000

export interface CompanionAwayOptions {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly attention: SmokeAttention
  readonly resources: Pick<RendererResourceScopes, 'currentOwner' | 'isCurrent'>
  readonly companion: SmokeCompanion
  readonly smokeRoot: HostPath
  /** The smoke store never records a spawn; the row and its Push title need the record. */
  readonly addRetained: (root: HostPath, session: TerminalRecoverySession) => void
}

export interface PairedListener {
  readonly port: number
  readonly bearer: Record<string, string>
}

export async function enableAndPair(companion: SmokeCompanion): Promise<PairedListener> {
  const { settings } = companion
  await settings.save({
    enabled: true,
    port: 0,
    mirrorInputAllowed: true,
    push: { url: SMOKE_PUSH_URL },
  })
  await waitFor(() => settings.view().status.listening, LISTENER_TIMEOUT_MS, 'listener open')
  const port = settings.view().status.port
  if (port === undefined) throw new Error('Companion status reported no port')
  const code = settings.issuePairing().pairing?.code
  if (code === undefined) throw new Error('Companion issued no pairing code')
  const paired = await send(port, 'POST', '/pair', { body: { code } })
  expectStatus(paired, 200, 'POST /pair')
  const token = (JSON.parse(paired.body) as { token: string }).token
  return { port, bearer: { authorization: `Bearer ${token}` } }
}

/** Disables the listener and waits for it to close. */
export async function disableListener(companion: SmokeCompanion): Promise<void> {
  await companion.settings.save({
    enabled: false,
    port: companion.settings.view().port,
    mirrorInputAllowed: false,
  })
  await waitFor(() => !companion.server.listening, LISTENER_TIMEOUT_MS, 'listener close')
}

export function retainedSmokeSession(
  terminal: ManagedPty,
  root: HostPath,
  title: string,
): TerminalRecoverySession {
  if (terminal.profileId === undefined) {
    throw new Error('away scenario terminal carries no profile')
  }
  return {
    id: terminal.id,
    providerId: terminal.providerId,
    profileId: terminal.profileId,
    launchRevision: terminal.launchRevision ?? 1,
    recoverySkipCount: 0,
    hostId: root.hostId,
    cwd: terminal.cwd,
    title,
    position: 0,
    active: true,
    updatedAt: Date.now(),
  }
}
