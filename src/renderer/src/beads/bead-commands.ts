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

import { isBeadId } from '../../../shared'
import { shellQuoteArg } from './gascity-commands'

export const BEAD_ACTIONS = ['claim', 'close', 'create'] as const

export type BeadAction = (typeof BEAD_ACTIONS)[number]

export type BeadActionRequest =
  | { readonly action: 'claim' | 'close'; readonly id: string }
  | { readonly action: 'create'; readonly title: string; readonly description?: string }

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
 * Build the shell command for a request, or undefined when it must not be
 * typed. No `-C`: the launched terminal's cwd is the workspace root, the same
 * assumption the gc commands make.
 *
 * Shell quoting protects the shell, not the line editor: the command is
 * delivered as PTY keystrokes, so a Ctrl-C or newline inside a quoted argument
 * still interrupts and submits. An id is therefore held to the bd grammar
 * (already enforced where bd output is parsed) and a title to "no control or
 * line-separator characters"; a value that fails is refused outright, never
 * rewritten into some other id.
 */
export function beadCommand(request: BeadActionRequest): BeadCommand | undefined {
  switch (request.action) {
    case 'claim':
      if (!isBeadId(request.id)) return undefined
      return { command: `bd update ${shellQuoteArg(request.id)} --claim` }
    case 'close':
      if (!isBeadId(request.id)) return undefined
      return { command: `bd close ${shellQuoteArg(request.id)}` }
    case 'create':
      if (TERMINAL_CONTROL.test(request.title) || (request.description !== undefined && TERMINAL_CONTROL.test(request.description))) return undefined
      // `--title` rather than a positional: a title starting with `-` would
      // otherwise be parsed by bd as a flag ("title required").
      return {
        command: `bd create --title ${shellQuoteArg(request.title)}${request.description ? ` --description ${shellQuoteArg(request.description)}` : ''}`,
      }
  }
}

/** C0/C1 controls plus the Unicode line and paragraph separators. */
const TERMINAL_CONTROL = /[\p{Cc}\u2028\u2029]/u

/**
 * Drop C0/C1 control characters, then collapse every whitespace run (newlines
 * included) to one space and trim. The command is delivered as keystrokes, so
 * shell quoting cannot help: a newline would submit early, and an ESC or Ctrl-C
 * byte would be read by the line editor as a key before the shell ever saw it.
 */
export function normalizeBeadTitle(raw: string): string {
  return raw
    .replaceAll(/\p{Cc}/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
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
