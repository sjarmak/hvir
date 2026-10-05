import { describe, expect, it } from 'vitest'

import type { OwnedTerminalSession } from '../src/main/terminal/session-registry'
import { assembleSessionsObservation } from '../src/main/sessions/sessions-observation-port'
import { createSessionsProjectionIdentityScope } from '../src/main/sessions/sessions-projection-identities'
import {
  resolveSessionsExternalAttach,
  resolveSessionsExternalSession,
} from '../src/main/sessions/sessions-external-resolution'
import {
  SESSIONS_ATTACH_TICKET_TTL_MS,
  SessionsAttachTicketRegistry,
} from '../src/main/sessions/sessions-attach-tickets'
import {
  type SessionsAttachExternalRequest,
  type SessionsObservationSnapshot,
  type SessionsTerminalHandle,
} from '../src/shared'

import {
  city,
  memRoot,
  memPanel,
  attachedTerminal,
  row,
  hostCity,
  projectState,
  hostOptions,
  providers,
} from './sessions-city-fixtures'

describe('exact resolution from a projected Gas City row', () => {
  it('answers what a row stands for and where an attach would land', () => {
    const identities = createSessionsProjectionIdentityScope()
    const observation = assembleSessionsObservation({
      projectState: projectState(),
      hosts: hostOptions(),
      providers: providers(),
      sessions: [],
      ptys: [],
      cities: [hostCity()],
      identities,
    })
    const worker = row(observation, 'mem-worker-1')
    const workspace = observation.workspaces.find(
      (candidate) => candidate.workspaceId === worker.workspaceId,
    )!

    expect(
      resolveSessionsExternalSession({
        request: {
          handle: worker.handle,
          projectionDemandGeneration: 3,
          sourceRevision: 5,
        },
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
      }),
    ).toEqual({
      outcome: 'resolved',
      // The foreign identifier and the city root live here, on main's side of
      // the boundary, and nowhere in the projection the renderer holds.
      target: {
        sourceId: 'gas-city',
        hostId: memRoot.hostId,
        key: 'gc-mem-worker-1',
        attachTarget: 'mem-worker-1',
        cityRoot: city,
      },
      live: false,
    })
    expect(
      resolveSessionsExternalAttach({
        request: attachRequest(worker.handle, workspace),
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
        projectState: projectState(),
      }),
    ).toMatchObject({
      outcome: 'resolved',
      projectId: `project:local:${memRoot.path}`,
      workspaceId: `workspace:local:${memPanel.path}`,
      attachTarget: 'mem-worker-1',
    })
  })

  it('refuses a row hvir owns outright and a projection that moved on', () => {
    const identities = createSessionsProjectionIdentityScope()
    const observation = assembleSessionsObservation({
      projectState: projectState(),
      hosts: hostOptions(),
      providers: providers(),
      sessions: [ownTerminal('own-shell')],
      ptys: [],
      cities: [hostCity()],
      identities,
    })
    const own = row(observation, 'Shell · main')
    const worker = row(observation, 'mem-worker-1')
    const workspace = observation.workspaces.find(
      (candidate) => candidate.workspaceId === worker.workspaceId,
    )!

    // hvir's own terminal is a session, but not one any supervisor can be asked
    // about: there is no exact join recorded for it.
    expect(
      resolveSessionsExternalSession({
        request: { handle: own.handle, projectionDemandGeneration: 3, sourceRevision: 5 },
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'not-projected' })
    expect(
      resolveSessionsExternalSession({
        request: {
          handle: worker.handle,
          projectionDemandGeneration: 3,
          sourceRevision: 4,
        },
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'stale-projection' })
    expect(
      resolveSessionsExternalAttach({
        request: attachRequest(own.handle, workspace),
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
        projectState: projectState(),
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'not-projected' })
  })

  it('mints a single-use ticket so a renderer can attach without the identifier', () => {
    const registry = new SessionsAttachTicketRegistry()
    const owner = { id: 7, generation: 4 }
    const attach = { sourceId: 'gas-city' as const, key: 'gc-mem-worker-1' }
    const ticket = registry.mint(owner, attach)

    expect(ticket).toMatch(/^[a-f0-9]{32}$/)
    expect(registry.redeem(owner, ticket)).toEqual(attach)
    // Spent: a second launch asks for a second ticket.
    expect(registry.redeem(owner, ticket)).toBeUndefined()
    // Another renderer, or the same one after a rollover, cannot spend it.
    const second = registry.mint(owner, attach)
    expect(registry.redeem({ id: 7, generation: 5 }, second)).toBeUndefined()
    expect(registry.redeem(owner, 'not-a-ticket')).toBeUndefined()
  })

  it('drops a ticket nobody redeemed before it went stale', () => {
    let now = 1_000
    const registry = new SessionsAttachTicketRegistry({ now: () => now })
    const owner = { id: 7, generation: 4 }
    const ticket = registry.mint(owner, { sourceId: 'gas-city', key: 'gc-mem-worker-1' })
    now += SESSIONS_ATTACH_TICKET_TTL_MS + 1

    expect(registry.redeem(owner, ticket)).toBeUndefined()
  })
})

function attachRequest(
  handle: SessionsTerminalHandle,
  workspace: SessionsObservationSnapshot['workspaces'][number],
): SessionsAttachExternalRequest {
  return {
    demandGeneration: 3,
    sourceRevision: 5,
    handle,
    projectId: workspace.projectId,
    workspaceId: workspace.workspaceId,
    workspaceQualifier: workspace.qualifier,
  }
}

/** A terminal hvir launched itself, attached to nothing foreign. */
function ownTerminal(id: string): OwnedTerminalSession {
  const { attachedExternalSession: _attached, ...rest } = attachedTerminal(id, 'unused')
  return rest
}
