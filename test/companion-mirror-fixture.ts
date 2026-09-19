/**
 * A fake PTY mirror door behind the Companion's mirror port: every attach is
 * recorded, every lease is controllable from the test (bytes, geometry, exit,
 * refusals), and the typing permission is a flag. Nothing here touches a PTY.
 */
import type { CompanionMirrorPorts } from '../src/main/companion/companion-sessions'
import { PtyMirrorRefusedError } from '../src/main/pty/pty-mirror-lease'
import type {
  PtyGeometry,
  PtyMirrorHandlers,
  PtyMirrorLease,
  PtyMirrorRefusal,
} from '../src/main/pty/pty-contract'
import type { PtyExit } from '../src/main/project-host'

export interface FakeMirrorLease extends PtyMirrorLease {
  readonly handlers: PtyMirrorHandlers
  /** Exact strings handed to `write`, in order. */
  readonly writes: string[]
  /** Exact sizes handed to `resize`, in order. */
  readonly resizes: PtyGeometry[]
  readonly released: boolean
  /** Every `write` and `resize` throws this refusal instead of recording, while set. */
  refuse?: PtyMirrorRefusal
  /** Ends the lease the way a PTY exit does: `onEnd` once, then writes refuse. */
  exit(exit: PtyExit): void
}

export interface FakeMirrorAttach {
  readonly ptyId: string
  readonly instanceId: string
}

export interface FakeMirrors {
  readonly attaches: FakeMirrorAttach[]
  readonly leases: FakeMirrorLease[]
  typingAllowed: boolean
  /** Every attach throws this refusal while set. */
  refuseAttach?: PtyMirrorRefusal
  tail: string
  geometry: PtyGeometry
  readonly ports: CompanionMirrorPorts
}

export function fakeMirrors(): FakeMirrors {
  const mirrors: FakeMirrors = {
    attaches: [],
    leases: [],
    typingAllowed: false,
    tail: '\u001b[2J$ ',
    geometry: { cols: 132, rows: 43 },
    ports: {
      attach: (ptyId, instanceId, handlers) => {
        mirrors.attaches.push({ ptyId, instanceId })
        if (mirrors.refuseAttach !== undefined) {
          throw new PtyMirrorRefusedError(mirrors.refuseAttach, ptyId)
        }
        const lease = fakeLease(ptyId, instanceId, handlers, mirrors)
        mirrors.leases.push(lease)
        return lease
      },
      typingAllowed: () => mirrors.typingAllowed,
    },
  }
  return mirrors
}

function fakeLease(
  ptyId: string,
  instanceId: string,
  handlers: PtyMirrorHandlers,
  source: Pick<FakeMirrors, 'tail' | 'geometry'>,
): FakeMirrorLease {
  let released = false
  let exited = false
  const live = () => !released && !exited
  const admit = (): void => {
    const refusal = lease.refuse ?? (released ? 'ended' : exited ? 'exited' : undefined)
    if (refusal !== undefined) throw new PtyMirrorRefusedError(refusal, ptyId)
  }
  const lease: FakeMirrorLease = {
    ptyId,
    instanceId,
    tail: source.tail,
    geometry: source.geometry,
    // Like the real lease: nothing reaches the holder once it let go or the stream ended.
    handlers: {
      onData: (data) => {
        if (live()) handlers.onData(data)
      },
      onGeometry: (geometry) => {
        if (live()) handlers.onGeometry(geometry)
      },
      onEnd: (end) => {
        if (!live()) return
        exited = true
        handlers.onEnd(end)
      },
    },
    writes: [],
    resizes: [],
    get ended() {
      return released || exited
    },
    get released() {
      return released
    },
    write(data) {
      admit()
      lease.writes.push(data)
    },
    resize(cols, rows) {
      admit()
      lease.resizes.push({ cols, rows })
    },
    release() {
      released = true
    },
    exit(exit) {
      lease.handlers.onEnd({ kind: 'exited', exit })
    },
  }
  return lease
}
