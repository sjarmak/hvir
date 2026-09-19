/**
 * The page's copy of one mirror's stream, keyed by row handle. Terminal
 * frames arrive on the event stream whenever the listener sends them, which
 * can be before the select reply lands or while no terminal view is mounted;
 * the feed keeps a bounded tail so the view that mounts later starts from the
 * same screen the listener sent, then forwards live frames to it.
 *
 * Only `opened` starts a buffer: output for a row the feed does not hold is
 * dropped, exactly as the listener drops output for a mirror it has ended.
 *
 * The feed holds a sticky-mode scanner beside the tail (ADR-054). The preamble
 * the listener sent describes main's window, not this one: this buffer re-cuts
 * its own tail to the same bound from the front on every replay, so a transition
 * the listener left to the tail can slide out of it here. The scanner reads the
 * opened preamble, the tail it arrived with and every later frame, and answers
 * for the window this replay is about to hand over.
 */
import {
  MAX_COMPANION_TERMINAL_TAIL_CHARS,
  TerminalStickyModes,
  type CompanionTerminalEvent,
  type SessionsTerminalHandle,
} from '../../../shared'

type Consumer = (event: CompanionTerminalEvent) => void

interface MirrorBuffer {
  readonly handle: SessionsTerminalHandle
  readonly cols: number
  readonly rows: number
  readonly tail: readonly string[]
  readonly tailLength: number
  readonly ended?: Extract<CompanionTerminalEvent, { type: 'ended' }>
}

export class CompanionMirrorFeed {
  private buffer?: MirrorBuffer
  private readonly modes = new TerminalStickyModes()
  private consumer?: {
    readonly handle: SessionsTerminalHandle
    readonly notify: Consumer
  }

  push(event: CompanionTerminalEvent): void {
    this.retainModes(event)
    this.buffer = nextBuffer(this.buffer, event)
    if (this.consumer?.handle === event.handle) this.consumer.notify(event)
  }

  /** Replays the buffer held for `handle`, then forwards its frames until detached. */
  attach(handle: SessionsTerminalHandle, notify: Consumer): () => void {
    const consumer = { handle, notify }
    this.consumer = consumer
    const buffer = this.buffer
    if (buffer !== undefined && buffer.handle === handle) {
      const tail = buffer.tail.join('').slice(-MAX_COMPANION_TERMINAL_TAIL_CHARS)
      const preamble = this.modes.preamble(tail.length)
      notify({
        type: 'opened',
        handle,
        cols: buffer.cols,
        rows: buffer.rows,
        ...(preamble.length > 0 ? { preamble } : {}),
        tail,
      })
      if (buffer.ended !== undefined) notify(buffer.ended)
    }
    return () => {
      if (this.consumer === consumer) this.consumer = undefined
    }
  }

  clear(): void {
    this.buffer = undefined
    this.modes.clear()
  }

  /** The scanner sees exactly the characters the buffer holds, in the order they arrived. */
  private retainModes(event: CompanionTerminalEvent): void {
    if (event.type === 'opened') {
      this.modes.clear()
      this.modes.retain(event.preamble ?? '')
      this.modes.retain(event.tail)
      return
    }
    if (event.type === 'output' && this.buffer?.handle === event.handle) {
      this.modes.retain(event.data)
    }
  }
}

function nextBuffer(
  buffer: MirrorBuffer | undefined,
  event: CompanionTerminalEvent,
): MirrorBuffer | undefined {
  if (event.type === 'opened') {
    return {
      handle: event.handle,
      cols: event.cols,
      rows: event.rows,
      tail: [event.tail],
      tailLength: event.tail.length,
    }
  }
  if (buffer === undefined || buffer.handle !== event.handle) return buffer
  switch (event.type) {
    case 'output':
      return { ...buffer, ...fold(buffer, event.data) }
    case 'geometry':
      return { ...buffer, cols: event.cols, rows: event.rows }
    case 'ended':
      return { ...buffer, ended: event }
  }
}

/**
 * Appends a chunk and compacts to the tail bound once the retained text is
 * twice the bound, so retaining stays amortised linear in the bytes received.
 */
function fold(
  buffer: Pick<MirrorBuffer, 'tail' | 'tailLength'>,
  data: string,
): Pick<MirrorBuffer, 'tail' | 'tailLength'> {
  const tail = [...buffer.tail, data]
  const tailLength = buffer.tailLength + data.length
  if (tailLength <= 2 * MAX_COMPANION_TERMINAL_TAIL_CHARS) return { tail, tailLength }
  const compacted = tail.join('').slice(-MAX_COMPANION_TERMINAL_TAIL_CHARS)
  return { tail: [compacted], tailLength: compacted.length }
}
