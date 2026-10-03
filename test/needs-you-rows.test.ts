import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import {
  asHostId,
  hostPath,
  asSessionsTerminalHandle,
  asSessionsProjectHandle,
  asSessionsWorkspaceHandle,
  asHarnessProviderId,
  sessionsWorkspaceQualifier,
  SESSIONS_HVIR_ORIGIN,
  type NeedsYouSourceSnapshot,
  type SessionsProjectionRow,
} from '../src/shared'
import { needsYouRows } from '../src/renderer/src/needs-you/needs-you-rows'

const source = (host: string, path: string, observedAt = 1): NeedsYouSourceSnapshot => ({
  projectId: `${host}-${path}`,
  workspaceId: path,
  projectName: 'Project',
  workspaceName: path,
  root: hostPath(asHostId(host), path),
  hostId: host,
  beads: {
    observedAt,
    response: {
      available: true,
      issues: [
        {
          id: 'same-id',
          title: 'Choose',
          status: 'open',
          priority: 1,
          issueType: 'decision',
          labels: [],
          dependencyCount: 0,
          dependentCount: 0,
        },
      ],
      readyIds: [],
      dispatchableIds: [],
      dispatchabilitySource: 'structural',
      dependencies: [],
      gates: [],
    },
  },
  pulls: {
    observedAt,
    response: {
      available: true,
      repo: 'org/repo',
      viewer: 'me',
      branchPulls: [],
      authored: [],
      reviewRequested: [
        {
          number: 1,
          title: 'Review',
          url: 'https://github.com/org/repo/pull/1',
          state: 'open',
          draft: false,
          headRef: 'feature',
          author: 'them',
          updatedAt: '2026-10-02',
          checks: 'passing',
          review: 'none',
          openFeedback: 0,
        },
      ],
    },
  },
})

describe('Needs you source identities', () => {
  it('includes only connected sessions with current attention and retains exact targets', () => {
    const unsupported = { status: 'unsupported' as const }
    const active: SessionsProjectionRow = {
      handle: asSessionsTerminalHandle('terminal'),
      origin: SESSIONS_HVIR_ORIGIN,
      project: { id: asSessionsProjectHandle('project'), name: 'Project' },
      workspace: {
        id: asSessionsWorkspaceHandle('workspace'),
        name: 'main',
        main: true,
        qualifier: sessionsWorkspaceQualifier(1, 0, 0),
      },
      host: { id: 'local', label: 'Local', kind: 'local', connectionState: 'connected' },
      provider: { id: asHarnessProviderId('codex'), name: 'Codex', kind: 'agent' },
      profile: unsupported,
      title: 'Question',
      lifecycle: 'live',
      connectionState: 'connected',
      attention: { status: 'available', value: 'prompt' },
      working: unsupported,
      model: unsupported,
      context: unsupported,
      turn: unsupported,
      telemetryFreshness: unsupported,
      usage: unsupported,
    }
    expect(needsYouRows([active], [])[0]).toMatchObject({
      reason: 'Prompt',
      target: { kind: 'session', row: active },
    })
    expect(
      needsYouRows(
        [
          { ...active, connectionState: 'disconnected' },
          {
            ...active,
            attention: {
              status: 'stale',
              value: 'prompt',
              observedAt: 1,
              reason: 'source-stale',
            },
          },
          { ...active, attention: { status: 'available', value: 'none' } },
        ],
        [],
      ),
    ).toEqual([])
  })

  it('keeps equal bead IDs distinct by host and path while deduplicating the same GitHub PR', () =>
    hegel.test((tc) => {
      const suffix = tc.draw(gs.integers({ minValue: 1, maxValue: 100000 }))
      const sources = [
        source('local', '/repo'),
        source(`ssh-${suffix}`, '/repo'),
        source('local', `/work-${suffix}`),
      ]
      const rows = needsYouRows([], sources)
      const beads = rows.filter((row) => row.target.kind === 'bead')
      expect(new Set(beads.map((row) => row.key)).size).toBe(3)
      expect(
        beads.map((row) => row.target.kind === 'bead' && row.target.bead.root),
      ).toEqual(sources.map((value) => value.root))
      expect(rows.filter((row) => row.target.kind === 'pull')).toHaveLength(1)
    }))

  it('lists decisions-store asks as unlinked rows ahead of workspace rows', () => {
    const workspace = source('local', '/repo')
    const rows = needsYouRows(
      [],
      [workspace],
      [
        {
          name: 'decisions',
          root: hostPath(asHostId('work'), '/city/decisions'),
          beads: {
            observedAt: 1,
            response: {
              ...workspace.beads.response,
              ...(workspace.beads.response.available
                ? {
                    issues: [
                      {
                        ...workspace.beads.response.issues[0]!,
                        id: 'dec-1',
                        title: 'Pick',
                      },
                    ],
                  }
                : {}),
            },
          },
        },
      ],
    )
    expect(rows[0]).toMatchObject({
      title: 'dec-1 · Pick',
      reason: 'Decision requested',
      context: 'decisions · work:/city/decisions',
      target: { kind: 'ask' },
    })
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })

  it('uses the newer successful repository read when a review request has cleared', () => {
    const earlier = source('local', '/repo', 1)
    const later = source('local', '/worktree', 2)
    const cleared = {
      ...later,
      pulls: {
        ...later.pulls,
        response: {
          available: true as const,
          repo: 'org/repo',
          viewer: 'me',
          authored: [],
          reviewRequested: [],
          branchPulls: [],
        },
      },
    }
    expect(
      needsYouRows([], [earlier, cleared]).filter((row) => row.target.kind === 'pull'),
    ).toEqual([])
  })

  it('does not carry a previous actionable row into a replacement unavailable snapshot', () => {
    const available = source('local', '/repo')
    const unavailable = {
      ...available,
      beads: {
        observedAt: 2,
        response: {
          available: false as const,
          reason: 'error' as const,
          message: 'offline',
        },
      },
      pulls: {
        observedAt: 2,
        response: {
          available: false as const,
          reason: 'error' as const,
          message: 'offline',
        },
      },
    }
    expect(needsYouRows([], [available])).toHaveLength(2)
    expect(needsYouRows([], [unavailable])).toEqual([])
  })
})
