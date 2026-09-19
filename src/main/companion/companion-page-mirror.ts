/**
 * One Companion page's mirror of a live terminal (ADR-050): at most one lease
 * at a time, bound to the exact PTY instance the page selected.
 *
 * The mirror translates the lease's stream into terminal events for the page
 * and ends exactly once, whatever ends it: a reselect, the page closing, the
 * PTY exiting, a supervisor release, or the page falling behind. Every end
 * releases the lease and tells the page why. Bytes pass through untouched in
 * both directions; nothing here logs, trims, or composes them. The one thing an
 * `opened` carries beyond the lease's own bytes is the sticky-mode preamble
 * (ADR-054), a distinct field the page writes before the tail, omitted entirely
 * when the stream set no mode the scanner carries. A resize (ADR-052) passes the
 * same lease checks as a write; only the Away door's `desktop-focused` answer is
 * a refusal the mirror survives.
 */
import type { CompanionMirrorEndReason, CompanionTerminalEvent } from '../../shared'
import type { SessionsTerminalHandle } from '../../shared'
import type {
  PtyMirrorHandlers,
  PtyMirrorLease,
  PtyMirrorRefusal,
} from '../pty/pty-contract'
import { PtyMirrorRefusedError } from '../pty/pty-mirror-lease'
import type { CompanionMirrorTarget } from './companion-mirror-target'

/** A write reached a lease that had already ended, or whose instance changed. */
export class CompanionMirrorEndedError extends Error {
  constructor() {
    super('The mirrored terminal ended or changed')
    this.name = 'CompanionMirrorEndedError'
  }
}

/** The desktop is not Away, so the PTY keeps the desktop's size; the mirror stays live. */
export class CompanionResizeRefusedError extends Error {
  readonly reason = 'desktop-focused'

  constructor() {
    super('The desktop is focused and holds the terminal size')
    this.name = 'CompanionResizeRefusedError'
  }
}

export type CompanionMirrorAttach = (
  ptyId: string,
  instanceId: string,
  handlers: PtyMirrorHandlers,
) => PtyMirrorLease

interface OpenMirror {
  readonly handle: SessionsTerminalHandle
  readonly lease: PtyMirrorLease
}

export class CompanionPageMirror {
  private current?: OpenMirror

  constructor(
    private readonly attach: CompanionMirrorAttach,
    private readonly emit: (event: CompanionTerminalEvent) => void,
  ) {}

  /** The row this page mirrors right now. */
  get handle(): SessionsTerminalHandle | undefined {
    return this.current?.handle
  }

  /**
   * Replaces any open mirror. A refused attach means the instance is already
   * gone, so the page hears `ended` and never `opened`.
   */
  open(handle: SessionsTerminalHandle, target: CompanionMirrorTarget): void {
    this.end('reselected')
    const opened: { mirror?: OpenMirror } = {}
    const endIfCurrent = (reason: CompanionMirrorEndReason): void => {
      if (opened.mirror !== undefined && this.current === opened.mirror) this.end(reason)
    }
    let lease: PtyMirrorLease
    try {
      lease = this.attach(target.ptyId, target.instanceId, {
        onData: (data) => this.emit({ type: 'output', handle, data }),
        onGeometry: ({ cols, rows }) =>
          this.emit({ type: 'geometry', handle, cols, rows }),
        onEnd: (end) => endIfCurrent(end.kind === 'exited' ? 'exited' : 'released'),
      })
    } catch (error) {
      if (!(error instanceof PtyMirrorRefusedError)) throw error
      this.emit({ type: 'ended', handle, reason: 'exited' })
      return
    }
    opened.mirror = { handle, lease }
    this.current = opened.mirror
    const { cols, rows } = lease.geometry
    const { preamble } = lease
    this.emit({
      type: 'opened',
      handle,
      cols,
      rows,
      ...(preamble.length > 0 ? { preamble } : {}),
      tail: lease.tail,
    })
  }

  /** Writes the user's exact bytes; any refusal ends the mirror and rethrows as ended. */
  write(data: string): void {
    this.admit((lease) => lease.write(data))
  }

  /**
   * Asks the PTY to take the phone's grid (ADR-052). `desktop-focused` is the
   * Away door saying not now and leaves the mirror as it is; every other
   * refusal means the lease is dead and ends the mirror as a write would.
   */
  resize(cols: number, rows: number): void {
    const refused = this.admit((lease) => lease.resize(cols, rows), 'desktop-focused')
    if (refused !== undefined) throw new CompanionResizeRefusedError()
  }

  /**
   * Runs one lease verb. Returns `survivable` when the lease refused with exactly
   * that reason and the mirror stays open; any other refusal ends the mirror
   * and throws as ended. A verb that names no survivable refusal never returns one.
   */
  private admit(
    verb: (lease: PtyMirrorLease) => void,
    survivable?: PtyMirrorRefusal,
  ): PtyMirrorRefusal | undefined {
    const current = this.current
    if (current === undefined) throw new CompanionMirrorEndedError()
    try {
      verb(current.lease)
      return undefined
    } catch (error) {
      if (!(error instanceof PtyMirrorRefusedError)) throw error
      if (survivable !== undefined && error.reason === survivable) return survivable
      this.end('exited')
      throw new CompanionMirrorEndedError()
    }
  }

  /** Idempotent. Releases the lease first, so nothing arrives after `ended`. */
  end(reason: CompanionMirrorEndReason): void {
    const current = this.current
    if (current === undefined) return
    this.current = undefined
    current.lease.release()
    this.emit({ type: 'ended', handle: current.handle, reason })
  }
}
