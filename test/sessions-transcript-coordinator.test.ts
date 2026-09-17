import { describe, expect, it, vi } from 'vitest'

import {
  SESSIONS_PROJECTION_VERSION,
  SESSIONS_TRANSCRIPT_VERSION,
  asSessionsTerminalHandle,
  type SessionsMutationResponse,
  type SessionsProjectionSnapshot,
  type SessionsTranscriptChange,
  type SessionsTranscriptSnapshot,
} from '../src/shared'
import { SessionsTranscriptCoordinator } from '../src/renderer/src/sessions/sessions-transcript-coordinator'

const HANDLE = asSessionsTerminalHandle('sessions-external-0001')

describe('SessionsTranscriptCoordinator mutations', () => {
  it('answers by the position the pane rendered, naming the prompt it answers', async () => {
    const world = await opened()

    await expect(world.coordinator.respond(1)).resolves.toEqual({
      outcome: 'accepted',
    })
    expect(world.main.respond).toHaveBeenCalledExactlyOnceWith({
      demandGeneration: 1,
      handle: HANDLE,
      pendingRevision: 4,
      optionOrdinal: 1,
    })
  })

  it('refuses to answer when the pane is showing no interaction', async () => {
    const world = await opened({ pending: false })

    await expect(world.coordinator.respond(0)).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'no-interaction',
    })
    expect(world.main.respond).not.toHaveBeenCalled()
  })

  it('sends one mutation at a time, and refuses the second rather than queueing it', async () => {
    const world = await opened()
    let finish: ((value: SessionsMutationResponse) => void) | undefined
    world.main.submit.mockImplementationOnce(
      () =>
        new Promise<SessionsMutationResponse>((resolve) => {
          finish = resolve
        }),
    )

    const first = world.coordinator.submit('first')
    expect(world.coordinator.isSending()).toBe(true)

    // A second send is a second message, not a retry of the first.
    await expect(world.coordinator.submit('second')).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'conflict',
    })
    expect(world.main.submit).toHaveBeenCalledTimes(1)

    finish?.({ outcome: 'accepted' })
    await expect(first).resolves.toEqual({ outcome: 'accepted' })
    expect(world.coordinator.isSending()).toBe(false)
  })

  it('reports a refused mutation to the pane without sending it again', async () => {
    const world = await opened()
    world.main.respond.mockResolvedValueOnce({
      outcome: 'unavailable',
      reason: 'denied',
    })

    await expect(world.coordinator.respond(0)).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'denied',
    })
    expect(world.main.respond).toHaveBeenCalledTimes(1)
    expect(world.coordinator.isSending()).toBe(false)
  })

  it('reports a mutation that threw as one that did not happen', async () => {
    const world = await opened()
    world.main.submit.mockRejectedValueOnce(new Error('channel closed'))

    await expect(world.coordinator.submit('anything')).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'stale-projection',
    })
    expect(world.coordinator.isSending()).toBe(false)
  })

  it('tells the pane when a send starts and when it ends', async () => {
    const world = await opened()
    const seen: boolean[] = []
    world.coordinator.subscribe(() => seen.push(world.coordinator.isSending()))

    await world.coordinator.submit('a message')

    expect(seen).toEqual([true, false])
  })

  it('refuses a mutation once the pane has closed', async () => {
    const world = await opened()
    world.coordinator.close()

    await expect(world.coordinator.submit('too late')).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'stale-projection',
    })
    expect(world.main.submit).not.toHaveBeenCalled()
  })
})

async function opened(options: { readonly pending?: boolean } = {}) {
  const main = {
    observe: vi.fn(() => Promise.resolve(transcript(options.pending !== false))),
    snapshot: vi.fn(() => Promise.resolve(transcript(options.pending !== false))),
    resume: vi.fn(() => Promise.resolve(transcript(options.pending !== false))),
    release: vi.fn(() => Promise.resolve()),
    respond: vi.fn(() => Promise.resolve<SessionsMutationResponse>({ outcome: 'accepted' })),
    submit: vi.fn(() => Promise.resolve<SessionsMutationResponse>({ outcome: 'accepted' })),
    subscribe: vi.fn((_listener: (change: SessionsTranscriptChange) => void) => () => {}),
  }
  const coordinator = new SessionsTranscriptCoordinator(main)
  coordinator.open(HANDLE, projection())
  await Promise.resolve()
  await Promise.resolve()
  return { coordinator, main }
}

function projection(): SessionsProjectionSnapshot {
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration: 3,
    revision: 5,
    sourceRevision: 7,
    status: 'available',
    rows: [],
  }
}

function transcript(pending: boolean): SessionsTranscriptSnapshot {
  return {
    version: SESSIONS_TRANSCRIPT_VERSION,
    demandGeneration: 1,
    revision: 1,
    handle: HANDLE,
    status: 'ready',
    stream: 'live',
    turns: [],
    older: false,
    dropped: 0,
    ...(pending
      ? {
          pending: {
            revision: 4,
            prompt: 'Run the migration against production?',
            options: [
              { ordinal: 0, label: 'allow' },
              { ordinal: 1, label: 'deny' },
            ],
          },
        }
      : {}),
  }
}
