/**
 * The gc command vocabulary the crew view offers. Every action is delivered as
 * a typed command in a real terminal rather than a background invocation, so it
 * stays visible and interruptible — and so the semantics of `reset` versus
 * `handoff` stay the user's call, not ours.
 */

import {
  gasCityAttachCommand,
  shellQuoteArg,
  type ExternalSessionAttachTarget,
} from '../../../shared'

export { shellQuoteArg }

export const GAS_CITY_ACTIONS = ['attach', 'peek', 'reset', 'handoff'] as const

export type GasCityAction = (typeof GAS_CITY_ACTIONS)[number]

export interface GasCityCommand {
  readonly command: string
  /**
   * Identity key for terminal reuse. Only `attach` carries one: it opens a
   * long-lived session view, so a repeat click should focus it. The others are
   * one-shot commands that want a fresh shell every time.
   */
  readonly key?: string
  /**
   * The gc session this command attaches to, named exactly. Only `attach`
   * carries one, and only when the caller could name the session rather than an
   * alias: it is what lets the terminal it opens be recognized later as the one
   * showing that session, instead of being matched by title or timing.
   */
  readonly attaches?: ExternalSessionAttachTarget
}

/** Subject `gc handoff` requires; the message body is left to the operator. */
const HANDOFF_SUBJECT = 'hvir handoff'

export const GAS_CITY_ACTION_LABELS: Readonly<Record<GasCityAction, string>> = {
  attach: 'Attach',
  peek: 'Peek',
  reset: 'Reset',
  handoff: 'Handoff',
}

export const GAS_CITY_ACTION_HINTS: Readonly<Record<GasCityAction, string>> = {
  attach: 'Open this session in a terminal',
  peek: 'Show recent output without attaching',
  reset: 'Restart with fresh provider state; bead and queued work are preserved',
  handoff: 'Mail context to the session and restart its controller',
}

export function gasCityCommand(
  action: GasCityAction,
  target: string,
  sessionId?: string,
): GasCityCommand {
  const quoted = shellQuoteArg(target)
  switch (action) {
    case 'attach':
      return {
        ...gasCityAttachCommand(target),
        ...(sessionId === undefined
          ? {}
          : { attaches: { sourceId: 'gas-city', key: sessionId } }),
      }
    case 'peek':
      return { command: `gc session peek ${quoted}` }
    case 'reset':
      return { command: `gc session reset ${quoted}` }
    case 'handoff':
      return {
        command: `gc handoff --target ${quoted} ${shellQuoteArg(HANDOFF_SUBJECT)}`,
      }
  }
}
