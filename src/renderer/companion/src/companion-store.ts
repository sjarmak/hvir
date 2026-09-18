/**
 * What the page shows, as pure state transitions. The listener's revisions
 * order updates; the page never reorders rows or invents a row of its own.
 */
import type {
  CompanionRow,
  CompanionSnapshot,
  SessionsTerminalHandle,
  SessionsTranscriptSnapshot,
} from '../../../shared'
import type { CompanionStreamEnd } from './companion-client'

export interface CompanionPageState {
  readonly snapshot?: CompanionSnapshot
  readonly selected?: SessionsTerminalHandle
  readonly transcript?: SessionsTranscriptSnapshot
}

export const EMPTY_COMPANION_PAGE: CompanionPageState = {}

export type CompanionConnection =
  | { readonly phase: 'unpaired'; readonly error?: string }
  | { readonly phase: 'connecting' }
  | { readonly phase: 'connected'; readonly page: string }
  | { readonly phase: 'disconnected'; readonly detail: string }

/** A snapshot from the same lease is applied only when it is newer. */
export function applyCompanionSnapshot(
  state: CompanionPageState,
  snapshot: CompanionSnapshot,
): CompanionPageState {
  const current = state.snapshot
  if (
    current !== undefined &&
    current.demandGeneration === snapshot.demandGeneration &&
    snapshot.revision <= current.revision
  ) {
    return state
  }
  return { ...state, snapshot }
}

/** A transcript is followed only for the selected row, and never backwards. */
export function applyCompanionTranscript(
  state: CompanionPageState,
  transcript: SessionsTranscriptSnapshot,
): CompanionPageState {
  if (transcript.handle !== state.selected) return state
  const current = state.transcript
  if (
    current !== undefined &&
    current.demandGeneration === transcript.demandGeneration &&
    transcript.revision < current.revision
  ) {
    return state
  }
  return { ...state, transcript }
}

export function selectCompanionRow(
  state: CompanionPageState,
  transcript: SessionsTranscriptSnapshot,
): CompanionPageState {
  return { ...state, selected: transcript.handle, transcript }
}

export function clearCompanionSelection(state: CompanionPageState): CompanionPageState {
  return { snapshot: state.snapshot }
}

export function selectedCompanionRow(
  state: CompanionPageState,
): CompanionRow | undefined {
  if (state.selected === undefined) return undefined
  return state.snapshot?.rows.find((row) => row.handle === state.selected)
}

export function describeStreamEnd(end: CompanionStreamEnd): string {
  switch (end.kind) {
    case 'closed':
      return `The desktop closed this page (${end.reason})`
    case 'lost':
      return end.message
    case 'protocol':
      return `The desktop sent something this page cannot read: ${end.message}`
    case 'aborted':
      return 'This page closed the connection'
  }
}
