/**
 * The Companion's view of the Sessions projection (ADR-049): the observed
 * sessions joined with the actionable set, as rows a phone can show.
 *
 * Pure. The join takes what the observation port projected, what the
 * actionable set reports, and a resolver from a row's handle to the foreign
 * session it stands for, and returns rows that carry none of it: no livePty,
 * no workspace qualifier, no host id, no foreign key. Attention is the
 * actionable set's word, not the projection's, so the page and the badge
 * cannot disagree about what is waiting on the person.
 */
import {
  compareCompanionRows,
  type CompanionRow,
  type SessionsAttentionValue,
  type SessionsFact,
  type SessionsObservationSnapshot,
  type SessionsObservedSession,
  type SessionsTerminalHandle,
  type SessionsWorkspaceProjection,
} from '../../shared'
import type { MainActionableEntry } from '../attention/actionable-attention-set'
import type { SessionsExternalSessionKey } from '../sessions/sessions-projection-identities'
import { companionMirrorEligible } from './companion-mirror-target'

export interface CompanionRowsInput {
  readonly observation: Pick<SessionsObservationSnapshot, 'workspaces' | 'sessions'>
  readonly actionable: readonly MainActionableEntry[]
  /** Main only: the foreign session a handle stands for, when it is external. */
  readonly resolveExternal: (
    handle: SessionsTerminalHandle,
  ) => SessionsExternalSessionKey | undefined
}

export function companionRows(input: CompanionRowsInput): readonly CompanionRow[] {
  const workspaces = new Map(
    input.observation.workspaces.map((workspace) => [workspace.workspaceId, workspace]),
  )
  const entries = indexEntries(input.actionable)
  const rows: CompanionRow[] = []
  for (const session of input.observation.sessions) {
    const workspace = workspaces.get(session.workspaceId)
    if (workspace === undefined) continue
    const external = input.resolveExternal(session.handle)
    const entry =
      entries.byHandle.get(session.handle) ??
      (external === undefined ? undefined : entries.byExternal.get(externalKey(external)))
    rows.push(companionRow(session, workspace, entry, external !== undefined))
  }
  return rows.sort(compareCompanionRows)
}

function indexEntries(entries: readonly MainActionableEntry[]) {
  const byHandle = new Map<SessionsTerminalHandle, MainActionableEntry>()
  const byExternal = new Map<string, MainActionableEntry>()
  for (const entry of entries) {
    if (entry.terminalHandle !== undefined) byHandle.set(entry.terminalHandle, entry)
    if (entry.external !== undefined) byExternal.set(externalKey(entry.external), entry)
  }
  return { byHandle, byExternal }
}

/** Lookup only: the key indexes entries and never reaches a row. */
function externalKey(key: SessionsExternalSessionKey): string {
  return `${key.sourceId}\u0000${key.hostId}\u0000${key.key}`
}

/**
 * Field by field on purpose: livePty, the workspace qualifier and host.id are
 * left behind because nothing copies them, not because something removes them.
 * `canMirror` is the one fact derived from livePty; the qualifier stays here.
 */
function companionRow(
  session: SessionsObservedSession,
  workspace: SessionsWorkspaceProjection,
  entry: MainActionableEntry | undefined,
  canAnswer: boolean,
): CompanionRow {
  const attention = attentionOf(entry, session.attention)
  return {
    handle: session.handle,
    title: session.title,
    project: { handle: workspace.projectId, name: workspace.projectName },
    workspace: {
      handle: workspace.workspaceId,
      name: workspace.workspaceName,
      hostLabel: workspace.host.label,
      hostKind: workspace.host.kind,
    },
    origin: session.origin,
    attention,
    ...promptBodyOf(entry, attention),
    freshness: entry?.freshness ?? 'fresh',
    ...(entry?.reason === undefined ? {} : { reason: entry.reason }),
    turn: session.telemetry.turn,
    canAnswer,
    canMirror: companionMirrorEligible(session, workspace),
  }
}

/**
 * The actionable set's word. A fresh entry is what is waiting now; a stale one
 * is the last thing seen, dated by the projection's own observation when it has
 * one, and reported unavailable rather than dated by guesswork when it has not.
 * No entry means nobody is watching this row for the Companion.
 */
function attentionOf(
  entry: MainActionableEntry | undefined,
  observed: SessionsFact<SessionsAttentionValue> | undefined,
): SessionsFact<SessionsAttentionValue> {
  if (entry === undefined) return { status: 'unsupported' }
  const observedAt = observedAtOf(observed)
  if (entry.freshness === 'fresh') {
    return {
      status: 'available',
      value: entry.kind,
      ...(observedAt === undefined ? {} : { observedAt }),
    }
  }
  if (observedAt === undefined) return { status: 'unavailable', reason: 'source-stale' }
  return { status: 'stale', value: entry.kind, observedAt, reason: 'source-stale' }
}

/** The message travels only with an available prompt, as the wire admits it (ADR-051). */
function promptBodyOf(
  entry: MainActionableEntry | undefined,
  attention: SessionsFact<SessionsAttentionValue>,
): Pick<CompanionRow, 'promptBody'> {
  const body = entry?.body
  return body !== undefined && attention.status === 'available' && attention.value === 'prompt'
    ? { promptBody: body }
    : {}
}

function observedAtOf(
  fact: SessionsFact<SessionsAttentionValue> | undefined,
): number | undefined {
  if (fact === undefined) return undefined
  return fact.status === 'available' || fact.status === 'stale'
    ? fact.observedAt
    : undefined
}
