/**
 * Tickets that stand in for a foreign session identifier.
 *
 * Sessions may hand the renderer no foreign identifier (ADR-046), and a launch
 * still has to record exactly which session it attached to (the join in
 * ADR-046 is recorded by the surface that performs the attach). A ticket closes
 * that gap: main mints an opaque value for the row the renderer asked to
 * attach, the renderer carries it into `pty:start`, and main redeems it against
 * the identifier it never sent.
 *
 * Scoped to the renderer that asked, bounded in number, and short lived, so a
 * ticket that leaks is useless to a later renderer and a renderer that asks
 * repeatedly cannot grow the registry.
 */
import { randomBytes } from 'node:crypto'

import {
  asSessionsExternalAttachTicket,
  isSessionsExternalAttachTicket,
  type ExternalSessionAttachTarget,
  type SessionsExternalAttachTicket,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'

/** Long enough to cover a selection, short enough to be worthless later. */
export const SESSIONS_ATTACH_TICKET_TTL_MS = 120_000

/** A renderer attaching this many sessions at once is not a real interaction. */
export const MAX_SESSIONS_ATTACH_TICKETS_PER_OWNER = 32

interface MintedTicket {
  readonly owner: string
  readonly target: ExternalSessionAttachTarget
  readonly expiresAt: number
}

export interface SessionsAttachTicketOptions {
  readonly now?: () => number
  /** Injectable for tests; defaults to 16 random bytes. */
  readonly mint?: () => string
}

export class SessionsAttachTicketRegistry {
  private readonly tickets = new Map<SessionsExternalAttachTicket, MintedTicket>()
  private readonly now: () => number
  private readonly mintValue: () => string

  constructor(options: SessionsAttachTicketOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.mintValue = options.mint ?? (() => randomBytes(16).toString('hex'))
  }

  /**
   * A ticket for one row. Repeating the same target returns a fresh ticket
   * rather than reusing one, because a redeemed ticket is spent and a second
   * attach is a second launch.
   */
  mint(
    owner: RendererOwner,
    target: ExternalSessionAttachTarget,
  ): SessionsExternalAttachTicket {
    this.sweep()
    const key = ownerKey(owner)
    const held = [...this.tickets.values()].filter(
      (ticket) => ticket.owner === key,
    ).length
    if (held >= MAX_SESSIONS_ATTACH_TICKETS_PER_OWNER) {
      throw new Error('Too many pending Sessions attach tickets')
    }
    const value = this.mintValue()
    if (!isSessionsExternalAttachTicket(value)) {
      throw new Error('Minted an invalid Sessions attach ticket')
    }
    this.tickets.set(value, {
      owner: key,
      target,
      expiresAt: this.now() + SESSIONS_ATTACH_TICKET_TTL_MS,
    })
    return value
  }

  /**
   * The session a ticket stands for, once. Redeeming spends it: a launch that
   * fails asks for another ticket rather than replaying this one.
   */
  redeem(owner: RendererOwner, value: string): ExternalSessionAttachTarget | undefined {
    this.sweep()
    if (!isSessionsExternalAttachTicket(value)) return undefined
    const ticket = this.tickets.get(asSessionsExternalAttachTicket(value))
    if (ticket === undefined || ticket.owner !== ownerKey(owner)) return undefined
    this.tickets.delete(asSessionsExternalAttachTicket(value))
    return ticket.target
  }

  /** Drops one renderer's tickets, or every ticket. */
  clear(owner?: RendererOwner): void {
    if (owner === undefined) {
      this.tickets.clear()
      return
    }
    const key = ownerKey(owner)
    for (const [value, ticket] of this.tickets) {
      if (ticket.owner === key) this.tickets.delete(value)
    }
  }

  private sweep(): void {
    const now = this.now()
    for (const [value, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(value)
    }
  }
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}
