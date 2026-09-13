/**
 * The bd write vocabulary the Beads panel offers: claim, close, create. Like
 * the gc crew actions, every one is delivered as a typed command in a real
 * terminal rather than a background invocation, so the command stays visible,
 * bd's own refusals (open children, live blockers) land where the user can
 * read them, and follow-up edits are one keystroke away.
 *
 * Create is title-first: the terminal runtime submits the initial input with a
 * trailing newline, so `bd create ` cannot be left half-typed for the user to
 * finish. The panel collects the title inline and builds the full command.
 */

import { shellQuoteArg } from './gascity-commands'

export const BEAD_ACTIONS = ['claim', 'close', 'create'] as const

export type BeadAction = (typeof BEAD_ACTIONS)[number]

export type BeadActionRequest =
  | { readonly action: 'claim' | 'close'; readonly id: string }
  | { readonly action: 'create'; readonly title: string }

/** All three are one-shot commands: none carries a terminal-reuse key. */
export interface BeadCommand {
  readonly command: string
}

export const BEAD_ACTION_LABELS: Readonly<Record<BeadAction, string>> = {
  claim: 'Claim',
  close: 'Close',
  create: 'Create bead',
}

export const BEAD_ACTION_HINTS: Readonly<Record<BeadAction, string>> = {
  claim: 'bd update <id> --claim: assign to you and mark in progress',
  close: 'bd close <id>; bd refuses if children or a live blocker are open',
  create: 'bd create with this title; edit fields afterwards in the terminal',
}

/**
 * Build the shell command for a request. No `-C`: the launched terminal's cwd
 * is the workspace root, the same assumption the gc commands make.
 */
export function beadCommand(request: BeadActionRequest): BeadCommand {
  switch (request.action) {
    case 'claim':
      return { command: `bd update ${shellQuoteArg(request.id)} --claim` }
    case 'close':
      return { command: `bd close ${shellQuoteArg(request.id)}` }
    case 'create':
      return { command: `bd create ${shellQuoteArg(request.title)}` }
  }
}

/**
 * Collapse every whitespace run (newlines included) to one space and trim. A
 * newline inside the title would submit the terminal command early.
 */
export function normalizeBeadTitle(raw: string): string {
  return raw.replaceAll(/\s+/g, ' ').trim()
}

/**
 * Which card actions apply to a bead in `status`. Keys on the raw bd status
 * string: closed beads get nothing, in-progress beads can only close, and any
 * other status (including ones bd adds later) offers both, leaving bd to refuse
 * an invalid transition in the terminal.
 */
export function availableBeadActions(status: string): readonly ('claim' | 'close')[] {
  if (status === 'closed') return []
  if (status === 'in_progress') return ['close']
  return ['claim', 'close']
}
