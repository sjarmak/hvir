import { describe, expect, it, vi } from 'vitest'

import { CompanionSessionsService } from '../src/main/companion/companion-sessions'
import type { MainActionableEntry } from '../src/main/attention/actionable-attention-set'
import {
  asHostId,
  asSessionsTerminalHandle,
  type CompanionEvent,
  type CompanionRow,
} from '../src/shared'
import {
  companionWorld,
  interaction,
  localRoot,
  retained,
} from './companion-sessions-fixture'

const EXTERNAL = asSessionsTerminalHandle('sessions-external-0001')
const OTHER = asSessionsTerminalHandle('sessions-external-0002')
const LOCAL = asSessionsTerminalHandle('local-session')

const pageIds = () => {
  let next = 0
  return () => `page-${(next += 1)}`
}

const externalEntry = (
  fields: Partial<MainActionableEntry> = {},
): MainActionableEntry => ({
  key: 'gas-city local gc-1',
  kind: 'ready',
  freshness: 'fresh',
  external: { sourceId: 'gas-city', hostId: asHostId('local'), key: 'gc-1' },
  ...fields,
})

describe('CompanionSessionsService', () => {
  it('opens each page on its own observation lease, held by a companion owner', () => {
    const world = companionWorld()
    const acquire = vi.spyOn(world.observation, 'acquire')
    const service = new CompanionSessionsService({
      ...world.ports,
      mintPageId: pageIds(),
    })

    const first = service.openPage()
    expect(acquire).toHaveBeenCalledExactlyOnceWith(
      { kind: 'companion', page: 'page-1', generation: 1 },
      1,
    )
    expect(first.snapshot).toMatchObject({ version: 1, revision: 1, demandGeneration: 1 })
    // Nothing is actionable yet, so rows read like the panel: project,
    // workspace, then title (the city rows are titled by their labels).
    expect(first.snapshot.rows.map((row) => row.handle)).toEqual([
      OTHER,
      EXTERNAL,
      LOCAL,
      asSessionsTerminalHandle('remote-session'),
    ])
    expect(world.sessions.listenerCount()).toBe(1)

    const second = service.openPage()
    expect(second.pageId).not.toBe(first.pageId)
    expect(acquire).toHaveBeenLastCalledWith(
      { kind: 'companion', page: 'page-2', generation: 2 },
      2,
    )
    expect(second.snapshot.demandGeneration).toBe(2)
    expect(service.openPages).toBe(2)
    expect(world.sessions.listenerCount()).toBe(1)
    expect(world.actionableListeners()).toBe(1)
    expect(service.snapshot(second.pageId)).toBe(second.snapshot)
    expect(() => service.snapshot('page-9')).toThrow('Companion page is not open')
    service.dispose()
  })

  it('selects a row on a transcript lease under the page lease, and retargets', async () => {
    const world = companionWorld()
    const acquire = vi.spyOn(world.transcripts, 'acquire')
    const service = new CompanionSessionsService({
      ...world.ports,
      mintPageId: pageIds(),
    })
    const page = service.openPage()
    const events: CompanionEvent[] = []
    page.events((event) => events.push(event))

    const opened = service.select(page.pageId, EXTERNAL)
    expect(acquire).toHaveBeenCalledExactlyOnceWith(
      { kind: 'companion', page: 'page-1', generation: 1 },
      {
        demandGeneration: 1,
        projectionDemandGeneration: 1,
        sourceRevision: world.observation.snapshot(
          { kind: 'companion', page: 'page-1', generation: 1 },
          1,
        ).revision,
        handle: EXTERNAL,
      },
    )
    expect(opened).toMatchObject({ handle: EXTERNAL, status: 'loading' })
    await world.settle()
    expect(events.at(-1)).toMatchObject({
      type: 'transcript',
      transcript: { handle: EXTERNAL, status: 'ready', stream: 'live' },
    })
    expect(world.transcripts.openStreams).toBe(1)

    service.select(page.pageId, OTHER)
    await world.settle()
    expect(world.streams.map((stream) => stream.closed)).toEqual([true, false])
    expect(world.transcripts.openStreams).toBe(1)
    expect(events.at(-1)).toMatchObject({
      type: 'transcript',
      transcript: { handle: OTHER },
    })
    service.dispose()
  })

  it('resumes a lost stream only when asked, and refuses without a selection', async () => {
    const world = companionWorld()
    const service = new CompanionSessionsService({
      ...world.ports,
      mintPageId: pageIds(),
    })
    const page = service.openPage()
    expect(() => service.resume(page.pageId)).toThrow('Companion page has no selection')

    service.select(page.pageId, EXTERNAL)
    await world.settle()
    world.streams[0]?.subscribers.onClose({ reason: 'unreachable', detail: 'socket' })
    await world.settle()
    expect(world.streams).toHaveLength(1)

    expect(service.resume(page.pageId)).toMatchObject({ handle: EXTERNAL })
    await world.settle()
    expect(world.streams).toHaveLength(2)
    service.dispose()
  })

  it('forwards an answer and a message under the page generation, verbatim', async () => {
    const world = companionWorld({ pending: () => interaction() })
    const respond = vi.spyOn(world.transcripts, 'respond')
    const submit = vi.spyOn(world.transcripts, 'submit')
    const service = new CompanionSessionsService({
      ...world.ports,
      mintPageId: pageIds(),
    })
    const page = service.openPage()
    const owner = { kind: 'companion', page: 'page-1', generation: 1 }
    await expect(
      service.respond(page.pageId, {
        handle: EXTERNAL,
        pendingRevision: 1,
        optionOrdinal: 0,
      }),
    ).rejects.toThrow('Companion page has no selection')

    service.select(page.pageId, EXTERNAL)
    await world.settle()
    const answer = await service.respond(page.pageId, {
      handle: EXTERNAL,
      pendingRevision: 1,
      optionOrdinal: 1,
      text: 'not on a Friday',
    })
    expect(answer).toEqual({ outcome: 'accepted' })
    expect(respond).toHaveBeenCalledExactlyOnceWith(owner, {
      demandGeneration: 1,
      handle: EXTERNAL,
      pendingRevision: 1,
      optionOrdinal: 1,
      text: 'not on a Friday',
    })
    expect(world.responded).toEqual([
      { action: 'deny', request_id: 'req-1', text: 'not on a Friday' },
    ])

    const sent = await service.submit(page.pageId, { handle: EXTERNAL, message: 'hold' })
    expect(sent).toEqual({ outcome: 'accepted' })
    expect(submit).toHaveBeenCalledExactlyOnceWith(owner, {
      demandGeneration: 1,
      handle: EXTERNAL,
      message: 'hold',
    })
    expect(world.submitted).toEqual([{ message: 'hold' }])
    // A refused answer is reported, not retried.
    expect(
      await service.respond(page.pageId, {
        handle: OTHER,
        pendingRevision: 1,
        optionOrdinal: 0,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'stale-projection' })
    service.dispose()
  })

  it('delivers a projection change to the page that leased it, and to no renderer', () => {
    const world = companionWorld()
    const service = new CompanionSessionsService({
      ...world.ports,
      mintPageId: pageIds(),
    })
    const first = service.openPage()
    const second = service.openPage()
    const firstEvents: CompanionEvent[] = []
    const secondEvents: CompanionEvent[] = []
    first.events((event) => firstEvents.push(event))
    second.events((event) => secondEvents.push(event))

    world.sessions.set([retained('local-session', localRoot, 'Renamed Codex')])
    expect(firstEvents).toHaveLength(1)
    expect(secondEvents).toHaveLength(1)
    expect(firstEvents[0]).toMatchObject({
      type: 'snapshot',
      snapshot: { revision: 2, demandGeneration: 1 },
    })
    expect(secondEvents[0]).toMatchObject({
      type: 'snapshot',
      snapshot: { revision: 2, demandGeneration: 2 },
    })
    const rows = (event: CompanionEvent | undefined): readonly CompanionRow[] =>
      event?.type === 'snapshot' ? event.snapshot.rows : []
    expect(rows(firstEvents[0]).map((row) => row.title)).toContain('Renamed Codex')
    expect(rows(firstEvents[0]).map((row) => row.title)).not.toContain('Remote Codex')
    expect(service.snapshot(first.pageId).revision).toBe(2)

    // A change for a generation the page no longer holds is not its change.
    world.sinks.projection(
      { kind: 'companion', page: first.pageId, generation: 9 },
      { demandGeneration: 9, revision: 99 },
    )
    world.sinks.projection(
      { kind: 'companion', page: 'page-9', generation: 1 },
      { demandGeneration: 1, revision: 99 },
    )
    expect(firstEvents).toHaveLength(1)
    expect(world.rendererEmits).toEqual([])
    expect(world.missing).toEqual([])
    service.dispose()
  })

  it('carries what the actionable set says, with its freshness and reason', () => {
    const world = companionWorld()
    const service = new CompanionSessionsService({
      ...world.ports,
      mintPageId: pageIds(),
    })
    const page = service.openPage()
    const events: CompanionEvent[] = []
    page.events((event) => events.push(event))
    const external = () =>
      service.snapshot(page.pageId).rows.find((row) => row.handle === EXTERNAL)

    expect(external()).toMatchObject({
      attention: { status: 'unsupported' },
      freshness: 'fresh',
      canAnswer: true,
    })
    world.actionable.setExternal([externalEntry()])
    expect(events).toHaveLength(1)
    expect(external()).toMatchObject({
      attention: { status: 'available', value: 'ready' },
      freshness: 'fresh',
    })
    expect(service.snapshot(page.pageId).rows[0]?.handle).toBe(EXTERNAL)

    world.actionable.setExternal([
      externalEntry({ freshness: 'stale', reason: 'unreachable', kind: 'bell' }),
    ])
    expect(events).toHaveLength(2)
    expect(external()).toMatchObject({
      attention: { status: 'unavailable', reason: 'source-stale' },
      freshness: 'stale',
      reason: 'unreachable',
    })
    // The same set again is not a change a page hears about.
    world.actionable.setExternal([
      externalEntry({ freshness: 'stale', reason: 'unreachable', kind: 'bell' }),
    ])
    expect(events).toHaveLength(2)
    service.dispose()
  })

  it('releases the transcript before the observation on close, then goes quiet', async () => {
    const world = companionWorld()
    const releaseTranscript = vi.spyOn(world.transcripts, 'release')
    const releaseObservation = vi.spyOn(world.observation, 'release')
    const service = new CompanionSessionsService({
      ...world.ports,
      mintPageId: pageIds(),
    })
    const first = service.openPage()
    const second = service.openPage()
    service.select(first.pageId, EXTERNAL)
    await world.settle()
    expect(world.transcripts.openStreams).toBe(1)

    service.closePage(first.pageId)
    expect(releaseTranscript).toHaveBeenCalledExactlyOnceWith(
      { kind: 'companion', page: 'page-1', generation: 1 },
      1,
    )
    expect(releaseObservation).toHaveBeenCalledExactlyOnceWith(
      { kind: 'companion', page: 'page-1', generation: 1 },
      1,
    )
    expect(releaseTranscript.mock.invocationCallOrder[0]).toBeLessThan(
      releaseObservation.mock.invocationCallOrder[0]!,
    )
    expect(world.transcripts.openStreams).toBe(0)
    expect(world.sessions.listenerCount()).toBe(1)
    expect(service.openPages).toBe(1)
    expect(() => service.snapshot(first.pageId)).toThrow('Companion page is not open')

    service.closePage(second.pageId)
    service.closePage(second.pageId)
    expect(service.openPages).toBe(0)
    expect(world.sessions.listenerCount()).toBe(0)
    expect(world.ptys.listenerCount()).toBe(0)
    expect(world.projects.listenerCount()).toBe(0)
    expect(world.cities.listenerCount()).toBe(0)
    expect(world.events.listenerCount()).toBe(0)
    expect(world.actionableListeners()).toBe(0)
    expect(world.transcripts.openStreams).toBe(0)
    expect(releaseTranscript).toHaveBeenCalledTimes(1)

    // A page opened after the quiet period starts the sources again.
    service.openPage()
    expect(world.sessions.listenerCount()).toBe(1)
    service.dispose()
    expect(world.sessions.listenerCount()).toBe(0)
  })

  it('tells every page it was closed before releasing anything on closeAll', async () => {
    const world = companionWorld()
    const releaseObservation = vi.spyOn(world.observation, 'release')
    const service = new CompanionSessionsService({
      ...world.ports,
      mintPageId: pageIds(),
    })
    const first = service.openPage()
    const second = service.openPage()
    service.select(second.pageId, EXTERNAL)
    await world.settle()
    const heard: { readonly page: string; readonly released: number }[] = []
    const listen = (page: string) => (event: CompanionEvent) => {
      if (event.type === 'closed' && event.reason === 'revoked') {
        heard.push({ page, released: releaseObservation.mock.calls.length })
      }
    }
    first.events(listen(first.pageId))
    const stop = second.events(listen(second.pageId))

    service.closeAll('revoked')
    expect(heard).toEqual([
      { page: first.pageId, released: 0 },
      { page: second.pageId, released: 0 },
    ])
    expect(releaseObservation).toHaveBeenCalledTimes(2)
    expect(service.openPages).toBe(0)
    expect(world.transcripts.openStreams).toBe(0)
    expect(world.sessions.listenerCount()).toBe(0)
    expect(world.actionableListeners()).toBe(0)
    void stop()
    service.dispose()
  })

  it('closes a page whose lease main no longer honours', () => {
    const world = companionWorld()
    const service = new CompanionSessionsService({
      ...world.ports,
      mintPageId: pageIds(),
    })
    const page = service.openPage()
    const events: CompanionEvent[] = []
    page.events((event) => events.push(event))

    world.observation.dispose()
    world.actionable.setExternal([externalEntry()])
    expect(events).toEqual([{ type: 'closed', reason: 'lease-lost' }])
    expect(service.openPages).toBe(0)
    expect(world.actionableListeners()).toBe(0)
    service.dispose()
  })

  it('registers the one companion sink for its lifetime and offers only Companion verbs', () => {
    const world = companionWorld()
    const service = new CompanionSessionsService(world.ports)
    expect(() => world.sinks.register(service as never)).toThrow('already registered')

    const verbs = Object.getOwnPropertyNames(CompanionSessionsService.prototype)
    for (const verb of ['resolveOpen', 'resolveExternalAttach', 'attach', 'usage']) {
      expect(verbs.some((name) => name.toLowerCase().includes(verb.toLowerCase()))).toBe(
        false,
      )
    }
    expect(verbs).toEqual(
      expect.arrayContaining([
        'openPage',
        'snapshot',
        'select',
        'resume',
        'respond',
        'submit',
        'closePage',
        'closeAll',
        'dispose',
      ]),
    )

    const page = service.openPage()
    expect(page.pageId).toMatch(/^[a-f0-9]{32}$/)
    service.dispose()
    expect(service.openPages).toBe(0)
    expect(() => service.openPage()).toThrow('Companion sessions are disposed')
    expect(() => world.sinks.register(service as never)).not.toThrow()
  })
})
