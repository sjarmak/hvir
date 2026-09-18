import { describe, expect, it } from 'vitest'

import { PTY_OUTPUT_TAIL_CHARS, PtyOutputTail } from '../src/main/pty/pty-output-tail'

describe('PtyOutputTail', () => {
  it('keeps the newest 256K characters across chunks', () => {
    expect(PTY_OUTPUT_TAIL_CHARS).toBe(256 * 1024)
    const tail = new PtyOutputTail()
    tail.retain('abc')
    tail.retain('x'.repeat(PTY_OUTPUT_TAIL_CHARS - 4))
    tail.retain('yy')
    expect(tail.text().length).toBe(PTY_OUTPUT_TAIL_CHARS)
    expect(tail.text().startsWith('bcxxx')).toBe(true)
    expect(tail.text().endsWith('xxyy')).toBe(true)
    tail.retain('zzz')
    expect(tail.text().startsWith('xxx')).toBe(true)
    expect(tail.text().endsWith('xyyzzz')).toBe(true)
    expect(tail.text().length).toBe(PTY_OUTPUT_TAIL_CHARS)
  })

  it('retains a long run of one-character chunks past the bound without slowing down', () => {
    const tail = new PtyOutputTail()
    const count = PTY_OUTPUT_TAIL_CHARS + 50_000
    const started = performance.now()
    for (let i = 0; i < count; i += 1) tail.retain(String.fromCharCode(97 + (i % 26)))
    const elapsedMs = performance.now() - started
    const text = tail.text()
    expect(text.length).toBe(PTY_OUTPUT_TAIL_CHARS)
    expect(text.charCodeAt(0)).toBe(97 + ((count - PTY_OUTPUT_TAIL_CHARS) % 26))
    expect(text.charCodeAt(text.length - 1)).toBe(97 + ((count - 1) % 26))
    expect(elapsedMs).toBeLessThan(2_000)
  })

  it('keeps only the tail of one oversized chunk', () => {
    const tail = new PtyOutputTail()
    tail.retain('earlier output')
    tail.retain(`discard${'z'.repeat(PTY_OUTPUT_TAIL_CHARS)}`)
    expect(tail.text()).toBe('z'.repeat(PTY_OUTPUT_TAIL_CHARS))
  })

  it('drain returns chunks in order and empties', () => {
    const tail = new PtyOutputTail()
    tail.retain('first')
    tail.retain(' second')
    expect(tail.drain()).toEqual(['first', ' second'])
    expect(tail.drain()).toEqual([])
    expect(tail.text()).toBe('')
    tail.retain('after drain')
    expect(tail.text()).toBe('after drain')
  })

  it('clear empties the tail', () => {
    const tail = new PtyOutputTail()
    tail.retain('gone')
    tail.clear()
    expect(tail.text()).toBe('')
    expect(tail.drain()).toEqual([])
  })

  it('a chunk starting with a lone low surrogate survives text() and a JSON round trip', () => {
    const tail = new PtyOutputTail()
    tail.retain(`a${'\u{1F600}'.repeat(PTY_OUTPUT_TAIL_CHARS / 2)}b`)
    const text = tail.text()
    expect(text.length).toBe(PTY_OUTPUT_TAIL_CHARS)
    expect(text.charCodeAt(0)).toBe(0xde00)
    expect(text.endsWith('\u{1F600}b')).toBe(true)
    expect(JSON.parse(JSON.stringify({ text })) as { text: string }).toEqual({ text })
  })
})
