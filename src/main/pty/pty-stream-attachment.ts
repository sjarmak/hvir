import type { HarnessTelemetry } from '../../shared'
import type { Disposer, PtyExit, PtyProcess } from '../project-host/project-host'
import type {
  PtyGeometry,
  PtyMirrorEnd,
  PtyMirrorHandlers,
  PtyStreamHandlers,
} from './pty-contract'
import { PtyOutputTail } from './pty-output-tail'

/**
 * Owns stream subscriptions, the bounded renderer replay, and the always-retained
 * mirror tail; never renderer authority.
 */
export class PtyStreamAttachment {
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(exit: PtyExit) => void>()
  private readonly telemetryListeners = new Set<
    (telemetry: HarnessTelemetry | undefined) => void
  >()
  private readonly mirrors = new Set<PtyMirrorHandlers>()
  /** Drained by the first renderer attach and re-armed on transfer. */
  private readonly replay = new PtyOutputTail()
  /** Fed on every byte; read, never drained, by mirrors. */
  private readonly mirrorTail = new PtyOutputTail()
  private replayPending = true
  private currentTelemetry?: HarnessTelemetry
  private disposeData?: Disposer
  private disposed = false

  get attached(): boolean {
    return this.dataListeners.size > 0
  }

  get telemetry(): HarnessTelemetry | undefined {
    return this.currentTelemetry
  }

  get tail(): string {
    return this.mirrorTail.text()
  }

  start(
    source: Pick<PtyProcess, 'onData'>,
    recordLaunchOutput: (data: string) => void,
  ): void {
    const dispose = source.onData((data) => {
      if (this.disposed) return
      recordLaunchOutput(data)
      if (this.replayPending && !this.attached) this.replay.retain(data)
      this.mirrorTail.retain(data)
      for (const listener of this.dataListeners) listener(data)
      for (const mirror of this.mirrors) mirror.onData(data)
    })
    if (this.disposed) void dispose()
    else this.disposeData = dispose
  }

  attach(handlers: PtyStreamHandlers): Disposer {
    if (handlers.onData) this.dataListeners.add(handlers.onData)
    if (handlers.onExit) this.exitListeners.add(handlers.onExit)
    if (handlers.onTelemetry) this.telemetryListeners.add(handlers.onTelemetry)
    if (handlers.onData && this.replayPending) {
      this.replayPending = false
      for (const data of this.replay.drain()) handlers.onData(data)
    }
    if (handlers.onTelemetry && this.telemetry) handlers.onTelemetry(this.telemetry)
    return () => {
      if (handlers.onData) this.dataListeners.delete(handlers.onData)
      if (handlers.onExit) this.exitListeners.delete(handlers.onExit)
      if (handlers.onTelemetry) this.telemetryListeners.delete(handlers.onTelemetry)
    }
  }

  /** A mirror is a separate reader: it never counts as the renderer attachment. */
  attachMirror(handlers: PtyMirrorHandlers): Disposer {
    this.mirrors.add(handlers)
    return () => {
      this.mirrors.delete(handlers)
    }
  }

  publishGeometry(geometry: PtyGeometry): void {
    for (const mirror of this.mirrors) mirror.onGeometry(geometry)
  }

  publishExit(exit: PtyExit): void {
    for (const listener of this.exitListeners) listener(exit)
    this.endMirrors({ kind: 'exited', exit })
  }

  publishTelemetry(telemetry: HarnessTelemetry | undefined): void {
    this.currentTelemetry = telemetry
    for (const listener of this.telemetryListeners) listener(telemetry)
  }

  detachForTransfer(): void {
    this.clearListeners()
    this.replayPending = true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    void this.disposeData?.()
    this.clearListeners()
    this.endMirrors({ kind: 'released' })
    this.replay.clear()
    this.mirrorTail.clear()
  }

  private endMirrors(end: PtyMirrorEnd): void {
    const ending = [...this.mirrors]
    this.mirrors.clear()
    for (const mirror of ending) mirror.onEnd(end)
  }

  private clearListeners(): void {
    this.dataListeners.clear()
    this.exitListeners.clear()
    this.telemetryListeners.clear()
  }
}
