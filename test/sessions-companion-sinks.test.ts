import { describe, expect, it, vi, type Mock } from 'vitest'

import {
  SessionsCompanionSinkRegistry,
  type SessionsCompanionSink,
} from '../src/main/sessions/sessions-companion-sinks'
import type { SessionsCompanionDemandOwner } from '../src/main/sessions/sessions-demand-owner'
import { asSessionsTerminalHandle } from '../src/shared'

const OWNER: SessionsCompanionDemandOwner = {
  kind: 'companion',
  page: 'p-1',
  generation: 1,
}
const HANDLE = asSessionsTerminalHandle('sessions-external-0001')

describe('SessionsCompanionSinkRegistry', () => {
  it('delivers every channel to the one registered sink', () => {
    const missing = vi.fn()
    const registry = new SessionsCompanionSinkRegistry(missing)
    const sink = fakeSink()
    const unregister = registry.register(sink)

    registry.projection(OWNER, { demandGeneration: 1, revision: 2 })
    registry.usage(OWNER, { demandGeneration: 1, revision: 3 })
    registry.transcript(OWNER, { demandGeneration: 1, revision: 4, handle: HANDLE })

    expect(sink.onProjectionChange).toHaveBeenCalledExactlyOnceWith(OWNER, {
      demandGeneration: 1,
      revision: 2,
    })
    expect(sink.onUsageChange).toHaveBeenCalledExactlyOnceWith(OWNER, {
      demandGeneration: 1,
      revision: 3,
    })
    expect(sink.onTranscriptChange).toHaveBeenCalledExactlyOnceWith(OWNER, {
      demandGeneration: 1,
      revision: 4,
      handle: HANDLE,
    })
    expect(missing).not.toHaveBeenCalled()
    void unregister()
  })

  it('records a missing sink per channel and never throws', () => {
    const missing = vi.fn()
    const registry = new SessionsCompanionSinkRegistry(missing)

    expect(() => {
      registry.projection(OWNER, { demandGeneration: 1, revision: 1 })
      registry.usage(OWNER, { demandGeneration: 1, revision: 1 })
      registry.transcript(OWNER, { demandGeneration: 1, revision: 1, handle: HANDLE })
    }).not.toThrow()
    expect(missing.mock.calls).toEqual([
      ['sessions:changed'],
      ['sessions:usage-changed'],
      ['sessions:transcript-changed'],
    ])
  })

  it('holds a single registration and releases it through its disposer only', () => {
    const missing = vi.fn()
    const registry = new SessionsCompanionSinkRegistry(missing)
    const first = fakeSink()
    const unregisterFirst = registry.register(first)
    expect(() => registry.register(fakeSink())).toThrow(
      'Sessions companion sink is already registered',
    )

    void unregisterFirst()
    registry.projection(OWNER, { demandGeneration: 1, revision: 1 })
    expect(first.onProjectionChange).not.toHaveBeenCalled()
    expect(missing).toHaveBeenCalledExactlyOnceWith('sessions:changed')

    const second = fakeSink()
    registry.register(second)
    // A stale disposer cannot evict the sink that replaced it.
    void unregisterFirst()
    registry.projection(OWNER, { demandGeneration: 1, revision: 2 })
    expect(second.onProjectionChange).toHaveBeenCalledOnce()

    registry.clear()
    registry.projection(OWNER, { demandGeneration: 1, revision: 3 })
    expect(second.onProjectionChange).toHaveBeenCalledOnce()
    expect(missing).toHaveBeenCalledTimes(2)
  })
})

function fakeSink(): {
  readonly onProjectionChange: Mock<SessionsCompanionSink['onProjectionChange']>
  readonly onUsageChange: Mock<SessionsCompanionSink['onUsageChange']>
  readonly onTranscriptChange: Mock<SessionsCompanionSink['onTranscriptChange']>
} {
  return {
    onProjectionChange: vi.fn(),
    onUsageChange: vi.fn(),
    onTranscriptChange: vi.fn(),
  }
}
