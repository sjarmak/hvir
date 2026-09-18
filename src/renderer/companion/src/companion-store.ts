/**
 * What the page shows, as pure state transitions. The listener's revisions
 * order updates; the page never reorders rows or invents a row of its own.
 * Terminal output never enters this state: the view writes it straight into
 * the pane, and only the mirror's status and geometry are kept here.
 */
import type {
  CompanionMirrorEndReason,
  CompanionRow,
  CompanionSnapshot,
  CompanionTerminalEvent,
  SessionsTerminalHandle,
  SessionsTranscriptSnapshot,
} from '../../../shared'
import type { CompanionStreamEnd } from './companion-client'

export type CompanionTerminalState =
  | {
      readonly handle: SessionsTerminalHandle
      readonly status: 'live'
      readonly cols: number
      readonly rows: number
    }
  | {
      readonly handle: SessionsTerminalHandle
      readonly status: 'ended'
      readonly reason: CompanionMirrorEndReason
    }

export interface CompanionPageState {
  readonly snapshot?: CompanionSnapshot
  readonly selected?: SessionsTerminalHandle
  readonly transcript?: SessionsTranscriptSnapshot
  readonly terminal?: CompanionTerminalState
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

/**
 * Terminal frames are followed for the selected row only. Output leaves the
 * state untouched; geometry moves a live mirror; `ended` closes it.
 */
export function applyCompanionTerminal(
  state: CompanionPageState,
  event: CompanionTerminalEvent,
): CompanionPageState {
  if (event.handle !== state.selected) return state
  switch (event.type) {
    case 'opened':
      return {
        ...state,
        terminal: {
          handle: event.handle,
          status: 'live',
          cols: event.cols,
          rows: event.rows,
        },
      }
    case 'output':
      return state
    case 'geometry':
      if (state.terminal?.status !== 'live') return state
      return {
        ...state,
        terminal: { ...state.terminal, cols: event.cols, rows: event.rows },
      }
    case 'ended':
      return {
        ...state,
        terminal: { handle: event.handle, status: 'ended', reason: event.reason },
      }
  }
}

/** The row is selected before the listener answers, so its frames are kept. */
export function beginCompanionSelection(
  state: CompanionPageState,
  handle: SessionsTerminalHandle,
): CompanionPageState {
  return { snapshot: state.snapshot, selected: handle }
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

/** Why a mirror ended, as a sentence; the reason code stays off the page. */
export function companionMirrorEndMessage(reason: CompanionMirrorEndReason): string {
  switch (reason) {
    case 'exited':
    case 'released':
      return 'The terminal ended.'
    case 'reselected':
      return 'Another row was selected.'
    case 'overrun':
      return 'The phone fell behind; select the row again.'
    case 'page-closed':
    case 'revoked':
    case 'shutdown':
    case 'lease-lost':
      return 'The desktop closed this mirror.'
  }
}
