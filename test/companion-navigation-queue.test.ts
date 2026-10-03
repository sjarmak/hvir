import { describe, expect, it } from 'vitest'

import { CompanionNavigationQueue } from '../src/renderer/companion/src/companion-navigation-queue'

const UP = '\x1b[<64;1;1M'
const DOWN = '\x1b[<65;1;1M'
const PAGE_UP = '\x1b[5~'

interface Sent {
  readonly batch: string
  readonly answer: (accepted: boolean) => void
  readonly reject: (error: unknown) => void
}

/** A sender whose round trips the test settles by hand, in any order. */
function sender(): { readonly sent: Sent[]; readonly send: (batch: string) => Promise<boolean> } {
  const sent: Sent[] = []
  return {
    sent,
    send: (batch) =>
      new Promise<boolean>((resolve, reject) => {
        sent.push({ batch, answer: resolve, reject })
      }),
  }
}

async function microtasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

describe('CompanionNavigationQueue', () => {
  it('keeps one request in flight and joins what arrives meanwhile into the next, in order', async () => {
    const queue = new CompanionNavigationQueue()
    const { sent, send } = sender()
    queue.push('m1', UP, send)
    queue.push('m1', UP, send)
    queue.push('m1', DOWN, send)
    expect(sent.map((s) => s.batch)).toEqual([UP])
    expect(queue.waiting('m1')).toBe(UP + DOWN)
    sent[0]!.answer(true)
    await microtasks()
    expect(sent.map((s) => s.batch)).toEqual([UP, UP + DOWN])
    expect(queue.waiting('m1')).toBe('')
    sent[1]!.answer(true)
    await microtasks()
    expect(sent).toHaveLength(2)
    // The next gesture starts a fresh round trip at once.
    queue.push('m1', PAGE_UP, send)
    expect(sent.map((s) => s.batch)).toEqual([UP, UP + DOWN, PAGE_UP])
  })

  it('a refusal drops what was waiting; the next gesture asks again on its own', async () => {
    const queue = new CompanionNavigationQueue()
    const { sent, send } = sender()
    queue.push('m1', UP, send)
    queue.push('m1', UP, send)
    sent[0]!.answer(false)
    await microtasks()
    expect(sent).toHaveLength(1)
    expect(queue.waiting('m1')).toBe('')
    queue.push('m1', DOWN, send)
    expect(sent.map((s) => s.batch)).toEqual([UP, DOWN])
  })

  it('a new mirror drops the reports waiting for the old one', async () => {
    const queue = new CompanionNavigationQueue()
    const { sent, send } = sender()
    queue.push('m1', UP, send)
    queue.push('m1', UP, send)
    queue.push('m2', DOWN, send)
    expect(queue.waiting('m1')).toBe('')
    expect(queue.waiting('m2')).toBe(DOWN)
    sent[0]!.answer(true)
    await microtasks()
    expect(sent.map((s) => s.batch)).toEqual([UP, DOWN])
  })

  it('clearing while a send is pending permits a fresh queue after reconnect', async () => {
    const queue = new CompanionNavigationQueue()
    const old = sender()
    const fresh = sender()
    queue.push('m1', UP, old.send)
    queue.clear()
    queue.push('m1', DOWN, fresh.send)
    expect(fresh.sent.map((s) => s.batch)).toEqual([DOWN])
    old.sent[0]!.answer(true)
    await microtasks()
    expect(fresh.sent.map((s) => s.batch)).toEqual([DOWN])
    fresh.sent[0]!.answer(true)
    await microtasks()

    const rejected = sender()
    queue.push('m1', PAGE_UP, rejected.send)
    queue.clear()
    rejected.sent[0]!.reject(new Error('late failure'))
    await microtasks()
    queue.push('m1', UP, fresh.send)
    expect(fresh.sent.map((s) => s.batch)).toEqual([DOWN, UP])
  })

  it('cuts a batch longer than the bound between tokens and never inside one', async () => {
    const queue = new CompanionNavigationQueue(3 * UP.length + 4)
    const { sent, send } = sender()
    queue.push('m1', UP, send)
    for (let i = 0; i < 5; i += 1) queue.push('m1', UP, send)
    sent[0]!.answer(true)
    await microtasks()
    expect(sent.map((s) => s.batch)).toEqual([UP, UP.repeat(3)])
    sent[1]!.answer(true)
    await microtasks()
    expect(sent.map((s) => s.batch)).toEqual([UP, UP.repeat(3), UP.repeat(2)])
  })
})
