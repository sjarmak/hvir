/**
 * The page's copy of one mirror's stream, keyed by row handle. Terminal
 * frames arrive on the event stream whenever the listener sends them, which
 * can be before the select reply lands or while no terminal view is mounted;
 * the feed keeps a bounded tail so the view that mounts later starts from the
 * same screen the listener sent, then forwards live frames to it.
 *
 * Only `opened` starts a buffer: output for a row the feed does not hold is
 * dropped, exactly as the listener drops output for a mirror it has ended.
 */
import {
  MAX_COMPANION_TERMINAL_TAIL_CHARS,
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
  private consumer?: {
    readonly handle: SessionsTerminalHandle
    readonly notify: Consumer
  }

  push(event: CompanionTerminalEvent): void {
    this.buffer = nextBuffer(this.buffer, event)
    if (this.consumer?.handle === event.handle) this.consumer.notify(event)
  }

  /** Replays the buffer held for `handle`, then forwards its frames until detached. */
  attach(handle: SessionsTerminalHandle, notify: Consumer): () => void {
    const consumer = { handle, notify }
    this.consumer = consumer
    const buffer = this.buffer
    if (buffer !== undefined && buffer.handle === handle) {
      notify({
        type: 'opened',
        handle,
        cols: buffer.cols,
        rows: buffer.rows,
        tail: buffer.tail.join('').slice(-MAX_COMPANION_TERMINAL_TAIL_CHARS),
      })
      if (buffer.ended !== undefined) notify(buffer.ended)
    }
    return () => {
      if (this.consumer === consumer) this.consumer = undefined
    }
  }

  clear(): void {
    this.buffer = undefined
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
