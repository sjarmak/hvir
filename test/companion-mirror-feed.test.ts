import { describe, expect, it } from 'vitest'

import { CompanionMirrorFeed } from '../src/renderer/companion/src/companion-mirror-feed'
import {
  MAX_COMPANION_TERMINAL_TAIL_CHARS,
  asSessionsTerminalHandle,
  type CompanionTerminalEvent,
} from '../src/shared'

const ROW = asSessionsTerminalHandle('row-1')
const OTHER = asSessionsTerminalHandle('row-2')

function opened(tail: string, cols = 120, rows = 40): CompanionTerminalEvent {
  return { type: 'opened', handle: ROW, cols, rows, tail }
}

/** The `opened` a fresh consumer is replayed, which is where the preamble is decided. */
function replayedOpen(
  feed: CompanionMirrorFeed,
): Extract<CompanionTerminalEvent, { type: 'opened' }> {
  const seen: CompanionTerminalEvent[] = []
  feed.attach(ROW, (event) => seen.push(event))()
  const first = seen[0]
  if (first?.type !== 'opened') throw new Error('expected an opened replay')
  return first
}

describe('CompanionMirrorFeed', () => {
  it('replays opened and buffered output to a late consumer in order', () => {
    const feed = new CompanionMirrorFeed()
    feed.push(opened('abc'))
    feed.push({ type: 'output', handle: ROW, data: 'def' })
    feed.push({ type: 'geometry', handle: ROW, cols: 100, rows: 30 })
    const seen: CompanionTerminalEvent[] = []
    const detach = feed.attach(ROW, (event) => seen.push(event))
    expect(seen).toEqual([
      { type: 'opened', handle: ROW, cols: 100, rows: 30, tail: 'abcdef' },
    ])

    feed.push({ type: 'output', handle: ROW, data: 'g' })
    feed.push({ type: 'ended', handle: ROW, reason: 'exited' })
    expect(seen.slice(1)).toEqual([
      { type: 'output', handle: ROW, data: 'g' },
      { type: 'ended', handle: ROW, reason: 'exited' },
    ])

    detach()
    feed.push({ type: 'output', handle: ROW, data: 'h' })
    expect(seen).toHaveLength(3)

    const late: CompanionTerminalEvent[] = []
    feed.attach(ROW, (event) => late.push(event))
    expect(late).toEqual([
      { type: 'opened', handle: ROW, cols: 100, rows: 30, tail: 'abcdefgh' },
      { type: 'ended', handle: ROW, reason: 'exited' },
    ])
  })

  it('folds output into the tail at the bound', () => {
    const feed = new CompanionMirrorFeed()
    feed.push(opened('x'.repeat(MAX_COMPANION_TERMINAL_TAIL_CHARS)))
    for (let index = 0; index < 5; index += 1) {
      feed.push({ type: 'output', handle: ROW, data: `y${index}`.repeat(1_000) })
    }
    feed.push({ type: 'output', handle: ROW, data: 'END' })
    const seen: CompanionTerminalEvent[] = []
    feed.attach(ROW, (event) => seen.push(event))
    const first = seen[0]
    if (first?.type !== 'opened') throw new Error('expected an opened replay')
    expect(first.tail).toHaveLength(MAX_COMPANION_TERMINAL_TAIL_CHARS)
    expect(first.tail.endsWith('y4y4END')).toBe(true)
    expect(first.tail.startsWith('x')).toBe(true)
  })

  it('a consumer for another handle receives nothing and a new opened replaces the buffer', () => {
    const feed = new CompanionMirrorFeed()
    feed.push(opened('abc'))
    const other: CompanionTerminalEvent[] = []
    feed.attach(OTHER, (event) => other.push(event))
    feed.push({ type: 'output', handle: ROW, data: 'd' })
    expect(other).toEqual([])

    feed.push({ type: 'opened', handle: OTHER, cols: 80, rows: 24, tail: 'fresh' })
    expect(other).toEqual([
      { type: 'opened', handle: OTHER, cols: 80, rows: 24, tail: 'fresh' },
    ])
    const row: CompanionTerminalEvent[] = []
    feed.attach(ROW, (event) => row.push(event))
    expect(row).toEqual([])
  })

  it('replays a preamble the listener sent after its own tail has been cut back', () => {
    const feed = new CompanionMirrorFeed()
    const live: CompanionTerminalEvent[] = []
    feed.attach(ROW, (event) => live.push(event))
    const opening: CompanionTerminalEvent = {
      type: 'opened',
      handle: ROW,
      cols: 120,
      rows: 40,
      preamble: '\u001b[?1049h',
      tail: 'x'.repeat(MAX_COMPANION_TERMINAL_TAIL_CHARS),
    }
    feed.push(opening)
    feed.push({
      type: 'output',
      handle: ROW,
      data: 'y'.repeat(MAX_COMPANION_TERMINAL_TAIL_CHARS + 1),
    })
    expect(live[0]).toEqual(opening)

    expect(replayedOpen(feed)).toEqual({
      type: 'opened',
      handle: ROW,
      cols: 120,
      rows: 40,
      preamble: '\u001b[?1049h',
      tail: 'y'.repeat(MAX_COMPANION_TERMINAL_TAIL_CHARS),
    })
  })

  it('carries a mode the listener left to the tail once its own tail rolls past it', () => {
    const feed = new CompanionMirrorFeed()
    feed.push(opened('$ vim\u001b[?1049hpaint'))
    feed.push({
      type: 'output',
      handle: ROW,
      data: 'y'.repeat(MAX_COMPANION_TERMINAL_TAIL_CHARS + 100),
    })
    expect(replayedOpen(feed).preamble).toBe('\u001b[?1049h')
  })

  it('drops a preamble the session has since undone in a later frame', () => {
    const feed = new CompanionMirrorFeed()
    feed.push({
      type: 'opened',
      handle: ROW,
      cols: 120,
      rows: 40,
      preamble: '\u001b[?1049h',
      tail: 'painting',
    })
    feed.push({ type: 'output', handle: ROW, data: '\u001b[?1049l$ ' })
    feed.push({
      type: 'output',
      handle: ROW,
      data: 'y'.repeat(MAX_COMPANION_TERMINAL_TAIL_CHARS + 100),
    })
    expect(replayedOpen(feed).preamble).toBeUndefined()
  })

  it('output before any opened is not retained and clear forgets the buffer', () => {
    const feed = new CompanionMirrorFeed()
    feed.push({ type: 'output', handle: ROW, data: 'early' })
    const seen: CompanionTerminalEvent[] = []
    feed.attach(ROW, (event) => seen.push(event))()
    expect(seen).toEqual([])
    feed.push(opened('abc'))
    feed.clear()
    feed.attach(ROW, (event) => seen.push(event))
    expect(seen).toEqual([])
  })
})
