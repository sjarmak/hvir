/**
 * Turns an actionable entry into the pointer a Push may carry (ADR-049): the
 * project, the session title, the kind of signal and at most one line of a
 * pending prompt. No options, no identifiers, no transcript, no credential.
 *
 * Reads the same owners the Sessions projection reads, directly and without a
 * lease (Push needs none: the set is current while hvir runs). Titles pass
 * through the projection's display scrub, so a title that repeats a harness
 * session id, a path or a session key is replaced exactly as a row would be.
 */
import {
  hostPathEquals,
  sessionsProjectionDisplayTitle,
  sessionsProjectionOptionalText,
  sessionsProjectionText,
  type ProjectState,
  type RegisteredProjectState,
  type SessionsTerminalHandle,
  type WorkspaceState,
} from '../../shared'
import type { MainActionableEntry } from '../attention/actionable-attention-set'
import type { ExternalPendingSession, GasCityAttention } from '../gascity/city-attention'
import type { SupervisorAccess } from '../gascity/supervisor-access'
import type { ProjectRegistry } from '../project-registry'
import type { SessionsExternalSessionKey } from '../sessions/sessions-projection-identities'
import type { OwnedTerminalSession, TerminalSessionRegistry } from '../terminal/session-registry'
import type { PushMessage } from './push-sink'

/** The longest prompt line a Push carries. */
export const PUSH_LINE_MAX = 120

export interface PushDescribeDiagnostic {
  readonly kind: 'prompt-unreadable'
  readonly reason: string
}

export interface PushDescribePorts {
  readonly terminals: Pick<TerminalSessionRegistry, 'get'>
  readonly projects: Pick<ProjectRegistry, 'state'>
  readonly supervisor: SupervisorAccess
  readonly external: Pick<GasCityAttention, 'pendingSessions'>
  /** A prompt line that could not be read; the Push goes out without it. */
  readonly onDiagnostic?: (diagnostic: PushDescribeDiagnostic) => void
}

export type PushDescriber = (entry: MainActionableEntry) => Promise<PushMessage | undefined>

interface Placement {
  readonly project: RegisteredProjectState
  readonly workspace: WorkspaceState
}

export function createPushDescriber(ports: PushDescribePorts): PushDescriber {
  return (entry) => {
    if (entry.terminalHandle !== undefined) {
      return Promise.resolve(describeTerminal(ports, entry, entry.terminalHandle))
    }
    if (entry.external !== undefined) return describeExternal(ports, entry, entry.external)
    return Promise.resolve(undefined)
  }
}

function describeTerminal(
  ports: PushDescribePorts,
  entry: MainActionableEntry,
  handle: SessionsTerminalHandle,
): PushMessage | undefined {
  const session = ports.terminals.get(entry.key)
  if (session === undefined) return undefined
  const place = placement(ports.projects.state(), (workspace) =>
    hostPathEquals(workspace.root, session.workspaceRoot),
  )
  const workspaceName = sessionsProjectionText(place?.workspace.name, 240, 'Workspace')
  return {
    project: projectName(place),
    title: terminalTitle(session, handle, workspaceName, place),
    kind: entry.kind,
  }
}

function terminalTitle(
  session: OwnedTerminalSession,
  handle: SessionsTerminalHandle,
  workspaceName: string,
  place: Placement | undefined,
): string {
  return sessionsProjectionDisplayTitle(
    session.title,
    handle,
    `${String(session.providerId)} · ${workspaceName}`,
    [
      session.workspaceRoot.path,
      session.cwd.path,
      session.harnessSessionId ?? '',
      place?.project.registeredRoot.path ?? '',
    ],
  )
}

async function describeExternal(
  ports: PushDescribePorts,
  entry: MainActionableEntry,
  key: SessionsExternalSessionKey,
): Promise<PushMessage | undefined> {
  const pending = ports.external
    .pendingSessions()
    .find((session) => session.hostId === key.hostId && session.sessionKey === key.key)
  if (pending === undefined) return undefined
  const place = placement(
    ports.projects.state(),
    (workspace) => workspace.id === pending.workspaceId,
  )
  const line = await promptLine(ports, pending)
  return {
    project: projectName(place),
    title: externalTitle(pending),
    kind: entry.kind,
    ...(line === undefined ? {} : { line }),
  }
}

/** The session's own title, unless it repeats the key it must not carry. */
function externalTitle(pending: ExternalPendingSession): string {
  const fallback = 'Session'
  const title = sessionsProjectionText(pending.title, 512, fallback)
  const repeatsKey =
    pending.title?.includes(pending.sessionKey) === true || title.includes(pending.sessionKey)
  return repeatsKey ? fallback : title
}

async function promptLine(
  ports: PushDescribePorts,
  pending: ExternalPendingSession,
): Promise<string | undefined> {
  try {
    const address = await ports.supervisor.address({
      hostId: pending.hostId,
      ...(pending.cityRoot === undefined ? {} : { cityRoot: pending.cityRoot }),
    })
    if (!address.ok) return unreadable(ports, address.failure.reason)
    const { client, cityName } = address.value
    const read = await client.sessionPending(cityName, pending.sessionKey)
    if (!read.ok) return unreadable(ports, read.failure.reason)
    if (!read.value.supported) return unreadable(ports, 'unsupported')
    return firstLine(read.value.pending?.prompt)
  } catch (error) {
    return unreadable(ports, error instanceof Error ? error.message : String(error))
  }
}

function unreadable(ports: PushDescribePorts, reason: string): undefined {
  ports.onDiagnostic?.({ kind: 'prompt-unreadable', reason })
  return undefined
}

function firstLine(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined
  return sessionsProjectionOptionalText(prompt.split(/\r?\n/, 1)[0], PUSH_LINE_MAX)
}

function projectName(place: Placement | undefined): string {
  return sessionsProjectionText(place?.project.displayName, 240, 'Project')
}

function placement(
  state: ProjectState,
  matches: (workspace: WorkspaceState) => boolean,
): Placement | undefined {
  for (const project of state.projects) {
    const workspace = project.workspaces.find(matches)
    if (workspace !== undefined) return { project, workspace }
  }
  return undefined
}
