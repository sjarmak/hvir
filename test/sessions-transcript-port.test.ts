import { describe, expect, it } from 'vitest'

import {
  asSessionsTerminalHandle,
  type HostId,
  type SessionsTerminalHandle,
  type SessionsTranscriptChange,
} from '../src/shared'
import type {
  SupervisorAccess,
  SupervisorAddressResult,
} from '../src/main/gascity/supervisor-access'
import type {
  GascitySupervisorClient,
  SupervisorStreamEvent,
  SupervisorStreamSubscribers,
  SupervisorStreamSubscription,
  SupervisorUnavailable,
} from '../src/main/gascity/supervisor-client'
import type { SessionTranscriptStructuredResponse } from '../src/main/gascity/generated-supervisor-transcript'
import type { SessionStreamStructuredMessageEvent } from '../src/main/gascity/generated-supervisor-api'
import type { SessionsResolvedExternalSession } from '../src/main/sessions/sessions-external-resolution'
import { SessionsTranscriptPort } from '../src/main/sessions/sessions-transcript-port'
import type { SessionsExternalSessionTarget } from '../src/main/sessions/sessions-projection-identities'

const OWNER = { id: 7, generation: 1 }
const HANDLE = asSessionsTerminalHandle('sessions-external-0001')
const OTHER = asSessionsTerminalHandle('sessions-external-0002')

describe('sessions transcript port', () => {
  it('reads the selected row transcript and follows its stream', async () => {
    const world = harness()
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(world.snapshot().status).toBe('ready')
    expect(world.snapshot().turns.map((turn) => turn.text)).toEqual(['ship the panel'])
    expect(world.snapshot().stream).toBe('live')
    expect(world.streams).toHaveLength(1)
    // The stream resumes from the cursor the transcript read already returned,
    // rather than replaying what the pane is showing.
    expect(world.streams[0]?.afterCursor).toBe('resume-1')

    world.streams[0]?.subscribers.onEvent(turnEvent('Reading the source.'))
    await world.settle()

    expect(world.snapshot().turns.map((turn) => turn.text)).toEqual([
      'ship the panel',
      'Reading the source.',
    ])
  })

  it('reports a dropped stream and reconnects only when asked', async () => {
    const world = harness()
    world.port.acquire(OWNER, request())
    await world.settle()
    world.streams[0]?.subscribers.onClose({ reason: 'unreachable', detail: 'socket' })
    await world.settle()

    expect(world.snapshot().stream).toBe('lost')
    expect(world.snapshot().streamReason).toBe('unreachable')
    // Nothing reopened on its own: the pane still holds the turns it had.
    expect(world.streams).toHaveLength(1)
    expect(world.snapshot().status).toBe('ready')
    expect(world.snapshot().turns).toHaveLength(1)

    world.port.resume(OWNER, 1)
    await world.settle()

    expect(world.streams).toHaveLength(2)
    expect(world.streams[1]?.afterCursor).toBe('resume-1')
    expect(world.snapshot().stream).toBe('live')
    expect(world.snapshot().turns).toHaveLength(1)
  })

  it('leaves no stream open once the detail is released', async () => {
    const world = harness()
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(world.port.openStreams).toBe(1)
    expect(world.port.release(OWNER, 1)).toBe(true)

    expect(world.port.openStreams).toBe(0)
    expect(world.streams[0]?.closed).toBe(true)
  })

  it('closes the previous stream when the selection moves to another row', async () => {
    const world = harness()
    world.port.acquire(OWNER, request())
    await world.settle()
    world.port.acquire(OWNER, request({ handle: OTHER }))
    await world.settle()

    expect(world.streams[0]?.closed).toBe(true)
    expect(world.port.openStreams).toBe(1)
    expect(world.snapshot().handle).toBe(OTHER)
  })

  it('renders the supervisor reason instead of an empty transcript', async () => {
    const world = harness({
      address: () => ({ ok: false, failure: { reason: 'unreachable' } }),
    })
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(world.snapshot()).toMatchObject({
      status: 'unavailable',
      reason: 'unreachable',
      stream: 'closed',
    })
    expect(world.streams).toHaveLength(0)
  })

  it('refuses a detail the projection has already moved past', async () => {
    const world = harness({
      resolve: () => ({ outcome: 'unavailable', reason: 'stale-projection' }),
    })
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(world.snapshot()).toMatchObject({
      status: 'unavailable',
      reason: 'stale-projection',
    })
  })

  it('drops the transcript when its row stops standing for that session', async () => {
    const world = harness()
    world.port.acquire(OWNER, request())
    await world.settle()
    world.current = () => ({ outcome: 'unavailable', reason: 'not-projected' })
    world.sourceChanged()
    await world.settle()

    expect(world.snapshot()).toMatchObject({
      status: 'unavailable',
      reason: 'not-projected',
    })
    expect(world.port.openStreams).toBe(0)
    expect(world.streams[0]?.closed).toBe(true)
  })

  it('notifies the renderer that asked, on a rising revision', async () => {
    const world = harness()
    world.port.acquire(OWNER, request())
    await world.settle()
    const revisions = world.changes.map((change) => change.revision)

    expect(world.changes.length).toBeGreaterThan(0)
    expect(
      world.changes.every(
        (change) => change.handle === HANDLE && change.demandGeneration === 1,
      ),
    ).toBe(true)
    // Every notification names a revision the renderer has not seen, and the
    // last one is the snapshot it will read.
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right))
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(revisions.at(-1)).toBe(world.snapshot().revision)
  })
})

function request(
  overrides: { readonly handle?: SessionsTerminalHandle } = {},
): Parameters<SessionsTranscriptPort['acquire']>[1] {
  return {
    demandGeneration: 1,
    projectionDemandGeneration: 3,
    sourceRevision: 5,
    handle: overrides.handle ?? HANDLE,
  }
}

interface FakeStream {
  readonly afterCursor: string | undefined
  readonly subscribers: SupervisorStreamSubscribers
  closed: boolean
}

function harness(
  overrides: {
    readonly address?: () => SupervisorAddressResult
    readonly resolve?: () => SessionsResolvedExternalSession
  } = {},
) {
  const streams: FakeStream[] = []
  const changes: SessionsTranscriptChange[] = []
  let sourceListener: (() => void) | undefined

  const client = {
    transcript: () => Promise.resolve({ ok: true as const, value: transcriptResponse() }),
    streamSession: (
      _city: string,
      _session: string,
      subscribers: SupervisorStreamSubscribers,
      afterCursor?: string,
    ): Promise<SupervisorStreamSubscription> => {
      const stream: FakeStream = { afterCursor, subscribers, closed: false }
      streams.push(stream)
      return Promise.resolve({
        close: () => {
          stream.closed = true
        },
        get cursor() {
          return afterCursor
        },
      })
    },
  } as unknown as GascitySupervisorClient

  const supervisor: SupervisorAccess = {
    address: () =>
      Promise.resolve(
        overrides.address?.() ?? { ok: true, value: { client, cityName: 'gastown' } },
      ),
  }

  const world = {
    port: undefined as unknown as SessionsTranscriptPort,
    streams,
    changes,
    current: (): SessionsResolvedExternalSession => resolved(),
    sourceChanged: () => sourceListener?.(),
    snapshot: () => world.port.snapshot(OWNER, 1),
    settle: async () => {
      // Two turns of the microtask queue: the port awaits its reads and then
      // notifies on a queued microtask.
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    },
  }

  world.port = new SessionsTranscriptPort({
    sessions: {
      resolveExternalSession: () => overrides.resolve?.() ?? resolved(),
      currentExternalSession: () => world.current(),
      observeSourceChanges: (listener) => {
        sourceListener = listener
        return () => {
          sourceListener = undefined
        }
      },
    },
    supervisor,
    emit: (_owner, change) => {
      changes.push(change)
    },
  })
  return world
}

function resolved(): SessionsResolvedExternalSession {
  return { outcome: 'resolved', target: target(), live: false }
}

function target(): SessionsExternalSessionTarget {
  return {
    sourceId: 'gas-city',
    hostId: 'local' as HostId,
    key: 'worker-1',
    attachTarget: 'pool-1',
  }
}

function transcriptResponse(): SessionTranscriptStructuredResponse {
  return {
    format: 'structured',
    history: history(),
    id: 'worker-1',
    operation: 'snapshot',
    provider: 'claude',
    schema_version: 'session.structured.v1',
    structured_messages: [
      {
        id: 'm1',
        role: 'user',
        status: 'final',
        blocks: [{ type: 'text', text: 'ship the panel' }],
      },
    ],
    template: 'structured',
  }
}

function turnEvent(text: string): SupervisorStreamEvent {
  const data: SessionStreamStructuredMessageEvent = {
    format: 'structured',
    history: history(),
    id: 'worker-1',
    operation: 'upsert',
    provider: 'claude',
    schema_version: 'session.structured.v1',
    structured_messages: [
      {
        id: 'm2',
        role: 'assistant',
        status: 'final',
        blocks: [{ type: 'text', text }],
      },
    ],
    template: 'structured',
  }
  return { kind: 'structured', data }
}

function history() {
  return {
    continuity: { status: 'continuous' },
    cursor: { resume_token: 'resume-1' },
    generation: { id: 'gen-1' },
    tail_state: { activity: 'idle' },
    transcript_stream_id: 'stream-1',
  }
}

// The unavailable shape the stream reports on a drop.
export type { SupervisorUnavailable }
