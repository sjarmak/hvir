import type { Disposer } from '../project-host/project-host'
import type {
  PtyGeometry,
  PtyMirrorHandlers,
  PtyMirrorLease,
  PtyMirrorRefusal,
  PtyRetainedOutput,
} from './pty-contract'

/** Carries the PTY id and the reason only; mirror bytes and sizes never enter a message. */
export class PtyMirrorRefusedError extends Error {
  override readonly name = 'PtyMirrorRefusedError'

  constructor(
    readonly reason: PtyMirrorRefusal,
    readonly ptyId: string,
  ) {
    super(`PTY mirror on '${ptyId}' refused: ${reason}`)
  }
}

/** One live entry as a lease sees it; the supervisor builds it fresh on every call. */
export interface PtyMirrorEntryView {
  readonly current: boolean
  readonly instanceId: string
  write(data: string): void
}

export interface PtyMirrorLeaseSources {
  readonly ptyId: string
  readonly instanceId: string
  /** The entry currently registered under `ptyId`, looked up fresh. */
  readonly entry: () => PtyMirrorEntryView | undefined
  readonly attach: (handlers: PtyMirrorHandlers) => Disposer
  /** The tail and its preamble read together, so the preamble matches this exact tail. */
  readonly retained: () => PtyRetainedOutput
  readonly geometry: () => PtyGeometry
  /** Fan-out after a write landed on the PTY; read-back navigation skips it (ADR-055). */
  readonly onInput: (data: string) => void
}

/** `released`: the holder let go. `ended`: the stream delivered `onEnd`. */
export type PtyMirrorLeaseState = 'live' | 'released' | 'ended'

/** The lease-state and instance checks every mirror verb passes before the entry's own door. */
export function mirrorRefusal(
  state: PtyMirrorLeaseState,
  current: PtyMirrorEntryView | undefined,
  instanceId: string,
): PtyMirrorRefusal | undefined {
  if (state === 'released') return 'ended'
  if (current !== undefined && current.instanceId !== instanceId)
    return 'instance-changed'
  if (state === 'ended' || current === undefined || !current.current) return 'exited'
  return undefined
}

function admitMirror(
  state: PtyMirrorLeaseState,
  current: PtyMirrorEntryView | undefined,
  sources: Pick<PtyMirrorLeaseSources, 'ptyId' | 'instanceId'>,
): PtyMirrorEntryView {
  const refusal = mirrorRefusal(state, current, sources.instanceId)
  if (refusal !== undefined || current === undefined) {
    throw new PtyMirrorRefusedError(refusal ?? 'exited', sources.ptyId)
  }
  return current
}

export function createPtyMirrorLease(
  sources: PtyMirrorLeaseSources,
  handlers: PtyMirrorHandlers,
): PtyMirrorLease {
  let state: PtyMirrorLeaseState = 'live'
  const { preamble, tail } = sources.retained()
  const geometry = sources.geometry()
  const detach = sources.attach({
    onData: (data) => {
      if (state === 'live') handlers.onData(data)
    },
    onGeometry: (next) => {
      if (state === 'live') handlers.onGeometry(next)
    },
    onEnd: (end) => {
      if (state !== 'live') return
      state = 'ended'
      handlers.onEnd(end)
    },
  })
  return {
    ptyId: sources.ptyId,
    instanceId: sources.instanceId,
    tail,
    preamble,
    geometry,
    get ended() {
      return state !== 'live'
    },
    write(data) {
      admitMirror(state, sources.entry(), sources).write(data)
      sources.onInput(data)
    },
    navigate(data) {
      admitMirror(state, sources.entry(), sources).write(data)
    },
    release() {
      if (state !== 'live') return
      state = 'released'
      void detach()
    },
  }
}
