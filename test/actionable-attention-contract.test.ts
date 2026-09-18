import { describe, expect, it } from 'vitest'

import {
  ACTIONABLE_ATTENTION_VERSION,
  EMPTY_RENDERER_ATTENTION_SET,
  MAX_ACTIONABLE_BODY_CHARS,
  MAX_ACTIONABLE_ENTRIES,
  MAX_SESSIONS_PROJECTION_ROWS,
  asSessionsTerminalHandle,
  isRendererAttentionSet,
} from '../src/shared'

const set = (entries: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  version: ACTIONABLE_ATTENTION_VERSION,
  entries,
  ...extra,
})

const entry = (fields: Record<string, unknown> = {}) => ({
  handle: asSessionsTerminalHandle('terminal-1'),
  kind: 'ready',
  freshness: 'fresh',
  ...fields,
})

describe('actionable attention contract', () => {
  it('accepts the empty set and fresh ready and bell entries', () => {
    expect(isRendererAttentionSet(EMPTY_RENDERER_ATTENTION_SET)).toBe(true)
    expect(
      isRendererAttentionSet(
        set([entry(), entry({ handle: 'terminal-2', kind: 'bell' })]),
      ),
    ).toBe(true)
  })

  it('accepts a stale entry only with its reason, and a reason only when stale', () => {
    // Both directions are the failure ADR-048 names: an entry that cannot say
    // why it is stale is asserting a state nobody is watching.
    expect(
      isRendererAttentionSet(set([entry({ freshness: 'stale', reason: 'unreachable' })])),
    ).toBe(true)
    expect(isRendererAttentionSet(set([entry({ freshness: 'stale' })]))).toBe(false)
    expect(isRendererAttentionSet(set([entry({ reason: 'unreachable' })]))).toBe(false)
    expect(
      isRendererAttentionSet(
        set([entry({ freshness: 'stale', reason: 'supervisor said no' })]),
      ),
    ).toBe(false)
  })

  it('accepts a prompt entry with or without its body, and the body only on a prompt', () => {
    expect(isRendererAttentionSet(set([entry({ kind: 'prompt' })]))).toBe(true)
    expect(
      isRendererAttentionSet(
        set([entry({ kind: 'prompt', body: 'Claude needs your permission' })]),
      ),
    ).toBe(true)
    expect(isRendererAttentionSet(set([entry({ body: 'Claude needs your permission' })]))).toBe(
      false,
    )
    expect(
      isRendererAttentionSet(set([entry({ kind: 'bell', body: 'Claude needs your permission' })])),
    ).toBe(false)
  })

  it('rejects a body over the bound, an empty one, and one that is not a string', () => {
    expect(MAX_ACTIONABLE_BODY_CHARS).toBe(120)
    const prompt = (body: unknown) => set([entry({ kind: 'prompt', body })])
    expect(isRendererAttentionSet(prompt('x'.repeat(MAX_ACTIONABLE_BODY_CHARS)))).toBe(true)
    expect(isRendererAttentionSet(prompt('x'.repeat(MAX_ACTIONABLE_BODY_CHARS + 1)))).toBe(
      false,
    )
    expect(isRendererAttentionSet(prompt(''))).toBe(false)
    expect(isRendererAttentionSet(prompt(7))).toBe(false)
    expect(isRendererAttentionSet(prompt(null))).toBe(false)
  })

  it('rejects an unknown kind, an unknown freshness, and an extra key', () => {
    expect(isRendererAttentionSet(set([entry({ kind: 'working' })]))).toBe(false)
    expect(isRendererAttentionSet(set([entry({ kind: 'none' })]))).toBe(false)
    expect(isRendererAttentionSet(set([entry({ freshness: 'live' })]))).toBe(false)
    expect(isRendererAttentionSet(set([entry({ title: 'leak' })]))).toBe(false)
    expect(isRendererAttentionSet(set([entry()], { count: 1 }))).toBe(false)
  })

  it('rejects an empty or non-string handle and a duplicate handle', () => {
    expect(isRendererAttentionSet(set([entry({ handle: '' })]))).toBe(false)
    expect(isRendererAttentionSet(set([entry({ handle: 7 })]))).toBe(false)
    expect(isRendererAttentionSet(set([entry(), entry({ kind: 'bell' })]))).toBe(false)
  })

  it('rejects another version and more entries than the cap allows', () => {
    expect(MAX_ACTIONABLE_ENTRIES).toBe(MAX_SESSIONS_PROJECTION_ROWS)
    expect(isRendererAttentionSet({ version: 2, entries: [] })).toBe(false)
    const entries = Array.from({ length: MAX_ACTIONABLE_ENTRIES + 1 }, (_, index) =>
      entry({ handle: `terminal-${index}` }),
    )
    expect(isRendererAttentionSet(set(entries))).toBe(false)
    expect(isRendererAttentionSet(set(entries.slice(1)))).toBe(true)
  })

  it('rejects a value that is not a set at all', () => {
    for (const candidate of [undefined, null, 'set', 3, [], { version: 1 }]) {
      expect(isRendererAttentionSet(candidate)).toBe(false)
    }
  })
})
