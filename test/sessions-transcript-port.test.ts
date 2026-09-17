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
import type {
  PendingInteraction,
  SessionRespondInputBody,
  SessionStreamStructuredMessageEvent,
  SessionSubmitInputBody,
} from '../src/main/gascity/generated-supervisor-api'
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

  it('carries the interaction the session is waiting on, with its options', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(world.snapshot().pending).toEqual({
      revision: 1,
      prompt: 'Run the migration against production?',
      options: [
        { ordinal: 0, label: 'allow' },
        { ordinal: 1, label: 'deny' },
      ],
    })
  })

  it('answers with the word the city published for that position', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()
    const answer = await world.port.respond(OWNER, {
      demandGeneration: 1,
      handle: HANDLE,
      pendingRevision: 1,
      optionOrdinal: 1,
    })
    await world.settle()

    expect(answer).toEqual({ outcome: 'accepted' })
    // The renderer named a position; gc is answered in its own vocabulary, and
    // with the interaction identifier the renderer never received.
    expect(world.responded).toEqual([{ action: 'deny', request_id: 'req-1' }])
  })

  it('clears the prompt on the answer and withdraws the attention it raised', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()
    const before = world.snapshot().revision
    await world.port.respond(OWNER, {
      demandGeneration: 1,
      handle: HANDLE,
      pendingRevision: 1,
      optionOrdinal: 0,
    })
    await world.settle()

    expect(world.snapshot().pending).toBeUndefined()
    expect(world.snapshot().revision).toBeGreaterThan(before)
    // Nothing was read again: the badge clears because the answer was given.
    expect(world.answered).toEqual([{ hostId: 'local', requestId: 'req-1' }])
  })

  it('refuses an answer to a prompt that has already changed', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()
    world.streams[0]?.subscribers.onEvent({
      kind: 'pending',
      data: interaction({ request_id: 'req-2', prompt: 'Force push to main?' }),
    })
    await world.settle()

    expect(world.snapshot().pending?.revision).toBe(2)
    expect(
      await world.port.respond(OWNER, {
        demandGeneration: 1,
        handle: HANDLE,
        pendingRevision: 1,
        optionOrdinal: 0,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'stale-interaction' })
    expect(world.responded).toEqual([])
  })

  it('refuses a position the session never offered', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(
      await world.port.respond(OWNER, {
        demandGeneration: 1,
        handle: HANDLE,
        pendingRevision: 1,
        optionOrdinal: 4,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'invalid-option' })
    expect(world.responded).toEqual([])
  })

  it('refuses an answer when nothing is waiting on one', async () => {
    const world = harness()
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(
      await world.port.respond(OWNER, {
        demandGeneration: 1,
        handle: HANDLE,
        pendingRevision: 1,
        optionOrdinal: 0,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'no-interaction' })
  })

  it('reports a refused answer and sends nothing a second time', async () => {
    const world = harness({
      pending: () => interaction(),
      respond: () => ({ ok: false, failure: { reason: 'denied' } }),
    })
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(
      await world.port.respond(OWNER, {
        demandGeneration: 1,
        handle: HANDLE,
        pendingRevision: 1,
        optionOrdinal: 0,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'denied' })
    expect(world.responded).toHaveLength(1)
    // The prompt stands: nothing was answered, so nothing was withdrawn.
    expect(world.snapshot().pending?.revision).toBe(1)
    expect(world.answered).toEqual([])
  })

  it('clears the interaction when the supervisor says it was cleared', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()
    world.streams[0]?.subscribers.onEvent({
      kind: 'pending-cleared',
      data: { request_id: 'req-1' },
    })
    await world.settle()

    expect(world.snapshot().pending).toBeUndefined()
  })

  it('keeps the interaction when a different one is cleared', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()
    world.streams[0]?.subscribers.onEvent({
      kind: 'pending-cleared',
      data: { request_id: 'req-9' },
    })
    await world.settle()

    expect(world.snapshot().pending?.revision).toBe(1)
  })

  it('shows the transcript when the interaction could not be read', async () => {
    const world = harness({
      pendingRead: () => ({ ok: false, failure: { reason: 'unreachable' } }),
    })
    world.port.acquire(OWNER, request())
    await world.settle()

    // A prompt hvir could not read is not a transcript hvir could not read.
    expect(world.snapshot().status).toBe('ready')
    expect(world.snapshot().pending).toBeUndefined()
    expect(world.snapshot().stream).toBe('live')
  })

  it('shows no prompt for a supervisor that does not declare interactions', async () => {
    const world = harness({ pending: () => interaction(), pendingSupported: false })
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(world.snapshot().pending).toBeUndefined()
  })

  it('sends a message, and leaves what the session is waiting on alone', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()
    const sent = await world.port.submit(OWNER, {
      demandGeneration: 1,
      handle: HANDLE,
      message: '  hold off until the release lands  ',
    })

    expect(sent).toEqual({ outcome: 'accepted' })
    expect(world.submitted).toEqual([{ message: 'hold off until the release lands' }])
    // Whether the message resolved the interaction is gc's to say, not hvir's.
    expect(world.snapshot().pending?.revision).toBe(1)
    expect(world.answered).toEqual([])
  })

  it('refuses a message with nothing in it', async () => {
    const world = harness()
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(
      await world.port.submit(OWNER, {
        demandGeneration: 1,
        handle: HANDLE,
        message: '   ',
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'invalid-message' })
    expect(world.submitted).toEqual([])
  })

  it('refuses a mutation aimed at a row the pane is no longer showing', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(
      await world.port.submit(OWNER, {
        demandGeneration: 1,
        handle: OTHER,
        message: 'wrong row',
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'stale-projection' })
    expect(world.submitted).toEqual([])
  })

  it('reports where a mutation cannot be addressed, and sends nothing', async () => {
    let addressed = 0
    const world = harness({
      pending: () => interaction(),
      address: (reachable) => {
        addressed += 1
        // The read reaches the host; the host is gone by the time someone answers.
        return addressed > 1 ? { ok: false, failure: { reason: 'unreachable' } } : reachable
      },
    })
    world.port.acquire(OWNER, request())
    await world.settle()

    expect(
      await world.port.submit(OWNER, {
        demandGeneration: 1,
        handle: HANDLE,
        message: 'still here?',
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'unreachable' })
    expect(world.submitted).toEqual([])
    // The transcript is untouched: nothing was sent, so nothing changed.
    expect(world.snapshot().status).toBe('ready')
  })

  it('drops the prompt with the transcript when the selection moves', async () => {
    const world = harness({ pending: () => interaction() })
    world.port.acquire(OWNER, request())
    await world.settle()
    world.port.acquire(OWNER, request({ handle: OTHER }))

    expect(world.snapshot().pending).toBeUndefined()
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
    /** Receives the reachable address, so a test can fail a later call only. */
    readonly address?: (reachable: SupervisorAddressResult) => SupervisorAddressResult
    readonly resolve?: () => SessionsResolvedExternalSession
    readonly pending?: () => PendingInteraction | undefined
    readonly pendingSupported?: boolean
    readonly pendingRead?: () => { readonly ok: false; readonly failure: { readonly reason: 'unreachable' } }
    readonly respond?: () => { readonly ok: false; readonly failure: { readonly reason: 'denied' } }
  } = {},
) {
  const streams: FakeStream[] = []
  const changes: SessionsTranscriptChange[] = []
  const responded: SessionRespondInputBody[] = []
  const submitted: SessionSubmitInputBody[] = []
  const answered: { readonly hostId: string; readonly requestId: string }[] = []
  let sourceListener: (() => void) | undefined

  const client = {
    transcript: () => Promise.resolve({ ok: true as const, value: transcriptResponse() }),
    sessionPending: () =>
      Promise.resolve(
        overrides.pendingRead?.() ?? {
          ok: true as const,
          value: {
            supported: overrides.pendingSupported ?? true,
            ...(overrides.pending?.() === undefined
              ? {}
              : { pending: overrides.pending?.() }),
          },
        },
      ),
    respond: (_city: string, _session: string, body: SessionRespondInputBody) => {
      responded.push(body)
      return Promise.resolve(
        overrides.respond?.() ?? { ok: true as const, value: { id: 'worker-1', status: 'ok' } },
      )
    },
    submit: (_city: string, _session: string, body: SessionSubmitInputBody) => {
      submitted.push(body)
      return Promise.resolve({
        ok: true as const,
        value: { event_cursor: '0', request_id: 'req-9', status: 'accepted' },
      })
    },
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

  const reachable: SupervisorAddressResult = {
    ok: true,
    value: { client, cityName: 'gastown' },
  }
  const supervisor: SupervisorAccess = {
    address: () => Promise.resolve(overrides.address?.(reachable) ?? reachable),
  }

  const world = {
    port: undefined as unknown as SessionsTranscriptPort,
    streams,
    changes,
    responded,
    submitted,
    answered,
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
    onPendingAnswered: (hostId, requestId) => {
      answered.push({ hostId, requestId })
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

function interaction(
  overrides: Partial<PendingInteraction> = {},
): PendingInteraction {
  return {
    kind: 'tool-approval',
    request_id: 'req-1',
    prompt: 'Run the migration against production?',
    options: ['allow', 'deny'],
    ...overrides,
  }
}
