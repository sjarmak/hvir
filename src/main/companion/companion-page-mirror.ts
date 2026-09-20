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
 * when the stream set no mode the scanner carries.
 */
import type { CompanionMirrorEndReason, CompanionTerminalEvent } from '../../shared'
import type { SessionsTerminalHandle } from '../../shared'
import type { PtyMirrorHandlers, PtyMirrorLease } from '../pty/pty-contract'
import { PtyMirrorRefusedError } from '../pty/pty-mirror-lease'
import type { CompanionMirrorTarget } from './companion-mirror-target'

/** A write reached a lease that had already ended, or whose instance changed. */
export class CompanionMirrorEndedError extends Error {
  constructor() {
    super('The mirrored terminal ended or changed')
    this.name = 'CompanionMirrorEndedError'
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
   * Pages a program through its own history (ADR-055). The same write and the
   * same refusals; it is left out of the input record the owning renderer keeps,
   * so reading back on a phone raises no attention.
   */
  navigate(data: string): void {
    this.admit((lease) => lease.navigate(data))
  }

  /**
   * The grid this page is drawing (ADR-058). The PTY takes that size for as long as this
   * mirror lasts, so the phone sees its own screen full whatever the desktop is doing.
   */
  viewport(cols: number, rows: number): void {
    this.admit((lease) => lease.viewport(cols, rows))
  }

  /** Runs one lease verb. A refusal means the lease is dead: the mirror ends and throws as ended. */
  private admit(verb: (lease: PtyMirrorLease) => void): void {
    const current = this.current
    if (current === undefined) throw new CompanionMirrorEndedError()
    try {
      verb(current.lease)
    } catch (error) {
      if (!(error instanceof PtyMirrorRefusedError)) throw error
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
