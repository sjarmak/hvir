import { describe, expect, it, vi } from 'vitest'

import {
  BeadsService,
  classifyListFailure,
  parseBeadsListOutput,
  parseDigraphEdges,
  parseDispatchableOutput,
  parseGatesOutput,
} from '../src/main/beads/beads-service'
import type { ProjectHost } from '../src/main/project-host'
import {
  asHostId,
  hostPath,
  type BeadsChangedEvent,
  type ExecResult,
} from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/projects/demo')

function execResult(code: number, stdout: string, stderr = ''): ExecResult {
  return { code, signal: null, stdout, stderr }
}

function issueJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo-1',
    title: 'Fix the flux capacitor',
    description: 'It fluxes when it should capacitate.',
    status: 'open',
    priority: 1,
    issue_type: 'bug',
    labels: ['power'],
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
    dependency_count: 2,
    dependent_count: 0,
    ...overrides,
  }
}

interface FakeHostOptions {
  readonly exec?: (
    command: string,
    args: readonly string[],
  ) => Promise<ExecResult> | ExecResult
  readonly statType?: 'dir' | 'file' | 'missing'
}

function fakeHost(options: FakeHostOptions = {}): {
  readonly host: ProjectHost
  readonly exec: ReturnType<typeof vi.fn>
  readonly watch: ReturnType<typeof vi.fn>
  readonly watchCallbacks: Array<(event: unknown) => void>
  readonly stopWatch: ReturnType<typeof vi.fn>
} {
  const watchCallbacks: Array<(event: unknown) => void> = []
  const stopWatch = vi.fn()
  const exec = vi.fn(async (command: string, args: readonly string[]) => {
    if (options.exec) return options.exec(command, args)
    return execResult(0, '[]')
  })
  const watch = vi.fn((_path: unknown, onEvent: (event: unknown) => void) => {
    watchCallbacks.push(onEvent)
    return stopWatch
  })
  const host = {
    hostId: ROOT.hostId,
    exec,
    stat: vi.fn(() =>
      options.statType === 'missing'
        ? Promise.reject(new Error('ENOENT: no such file'))
        : Promise.resolve({ type: options.statType ?? 'dir' }),
    ),
    watch,
  } as unknown as ProjectHost
  return { host, exec, watch, watchCallbacks, stopWatch }
}

function service(host: ProjectHost, emitted: BeadsChangedEvent[] = []): BeadsService {
  return new BeadsService({
    getProject: () => ({ host, root: ROOT }),
    emitChanged: (event) => emitted.push(event),
  })
}

describe('BeadsService.list', () => {
  it('returns parsed issues and ready ids from two bd invocations', async () => {
    const { host, exec } = fakeHost({
      exec: (_command, args) =>
        execResult(
          0,
          args.includes('--ready')
            ? JSON.stringify([issueJson()])
            : JSON.stringify([
                issueJson(),
                issueJson({ id: 'demo-2', status: 'in_progress' }),
              ]),
        ),
    })
    const result = await service(host).list({ root: ROOT })
    expect(result.available).toBe(true)
    if (!result.available) throw new Error('unreachable')
    expect(result.issues.map((issue) => issue.id)).toEqual(['demo-1', 'demo-2'])
    expect(result.readyIds).toEqual(['demo-1'])
    expect(result.closedIssues).toBeUndefined()
    expect(result.issues[0]).toMatchObject({
      issueType: 'bug',
      priority: 1,
      labels: ['power'],
      acceptanceCriteria: undefined,
      dependencyCount: 2,
    })
    const [command, args] = exec.mock.calls[0] as [string, readonly string[]]
    expect(command).toBe('bd')
    expect(args).toEqual(
      expect.arrayContaining(['-C', ROOT.path, 'list', '--json', '--flat', '-n', '0']),
    )
    // Enrichment calls (dependency edges + gates) run after the core pair; the
    // ready query is still exactly `bd list --ready`.
    expect(
      exec.mock.calls.some(([, callArgs]) => (callArgs as string[]).includes('--ready')),
    ).toBe(true)
  })

  it('uses a login shell and never strips the environment (port-file operation)', async () => {
    // Port-file-only operation depends on bd inheriting the full environment
    // and resolving `.beads/dolt-server.port` under the requested root. The
    // service must request a login shell and must not pass `env`/`unsetEnv`,
    // which would drop BEADS_DOLT_* overrides or PATH.
    const { host, exec } = fakeHost()
    await service(host).list({ root: ROOT })
    expect(exec.mock.calls.length).toBeGreaterThan(0)
    for (const call of exec.mock.calls) {
      const [command, , opts] = call as [
        string,
        readonly string[],
        { loginShell?: boolean; env?: unknown; unsetEnv?: unknown } | undefined,
      ]
      // Every shelled command (bd list/gate/digraph) inherits the full env via a
      // login shell so BEADS_DOLT_* overrides and PATH resolve.
      expect(command).toBe('bd')
      expect(opts?.loginShell).toBe(true)
      expect(opts?.env).toBeUndefined()
      expect(opts?.unsetEnv).toBeUndefined()
    }
    // The core list query still carries the canonical flags.
    const listCall = exec.mock.calls.find(([, args]) =>
      (args as string[]).includes('--json') && (args as string[]).includes('--flat'),
    )
    expect(listCall?.[1]).toEqual(
      expect.arrayContaining(['-C', ROOT.path, 'list', '--json', '--flat', '--no-pager']),
    )
  })

  it('surfaces an unreachable Dolt server as an actionable port-file error', async () => {
    const { host } = fakeHost({
      exec: () =>
        execResult(
          1,
          '',
          'Error: failed to open database: Dolt server unreachable at 127.0.0.1:0: ' +
            'dial tcp 127.0.0.1:0: connect: connection refused',
        ),
    })
    const result = await service(host).list({ root: ROOT })
    expect(result).toMatchObject({ available: false, reason: 'server-unreachable' })
    if (result.available) throw new Error('unreachable')
    expect(result.message).toContain(`${ROOT.path}/.beads/dolt-server.port`)
    expect(result.message).toContain('BEADS_DOLT_SERVER_PORT')
  })

  it('fetches closed issues only when requested', async () => {
    const { host, exec } = fakeHost({
      exec: (_command, args) =>
        execResult(
          0,
          args.includes('closed')
            ? JSON.stringify([issueJson({ id: 'demo-9', status: 'closed' })])
            : '[]',
        ),
    })
    const result = await service(host).list({ root: ROOT, includeClosed: true })
    if (!result.available) throw new Error('expected availability')
    expect(result.closedIssues?.map((issue) => issue.id)).toEqual(['demo-9'])
    expect(
      exec.mock.calls.some(([, args]) =>
        (args as string[]).includes('--status') && (args as string[]).includes('closed'),
      ),
    ).toBe(true)
  })

  it('omits the closed query when not requested', async () => {
    const { host, exec } = fakeHost()
    await service(host).list({ root: ROOT })
    expect(
      exec.mock.calls.some(([, args]) => (args as string[]).includes('closed')),
    ).toBe(false)
  })

  it('classifies a missing database, a missing CLI, and other failures', async () => {
    const noDb = fakeHost({
      exec: () =>
        execResult(1, '', 'Error: cannot use -C directory: no beads project found'),
    })
    expect(await service(noDb.host).list({ root: ROOT })).toMatchObject({
      available: false,
      reason: 'no-database',
    })

    const missingCli = fakeHost({
      exec: () => Promise.reject(new Error('spawn bd ENOENT')),
    })
    expect(await service(missingCli.host).list({ root: ROOT })).toMatchObject({
      available: false,
      reason: 'bd-missing',
    })

    const broken = fakeHost({
      exec: () => execResult(2, '', 'dolt server exploded'),
    })
    expect(await service(broken.host).list({ root: ROOT })).toMatchObject({
      available: false,
      reason: 'error',
      message: 'dolt server exploded',
    })
  })

  it('reports malformed bd JSON as an error state instead of throwing', async () => {
    const { host } = fakeHost({
      exec: () => execResult(0, 'not json at all'),
    })
    expect(await service(host).list({ root: ROOT })).toMatchObject({
      available: false,
      reason: 'error',
    })
  })

  it('rejects requests for roots other than the active workspace', async () => {
    const { host, exec } = fakeHost()
    const other = hostPath(asHostId('local'), '/projects/other')
    await expect(service(host).list({ root: other })).rejects.toThrow(
      /active workspace root/,
    )
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('BeadsService.probe', () => {
  it('reports a project when .beads is a directory', async () => {
    const { host } = fakeHost({ statType: 'dir' })
    expect(await service(host).probe(ROOT)).toEqual({ hasProject: true })
  })

  it('reports no project when .beads is absent or not a directory', async () => {
    const missing = fakeHost({ statType: 'missing' })
    expect(await service(missing.host).probe(ROOT)).toEqual({ hasProject: false })
    const file = fakeHost({ statType: 'file' })
    expect(await service(file.host).probe(ROOT)).toEqual({ hasProject: false })
  })

  it('never shells out to bd', async () => {
    const { host, exec } = fakeHost({ statType: 'dir' })
    await service(host).probe(ROOT)
    expect(exec).not.toHaveBeenCalled()
  })

  it('rejects a probe for a root other than the active workspace', async () => {
    const { host } = fakeHost({ statType: 'dir' })
    const other = hostPath(asHostId('local'), '/projects/other')
    await expect(service(host).probe(other)).rejects.toThrow(/active workspace root/)
  })
})

describe('BeadsService watch lifecycle', () => {
  it('watches .beads once, debounces bursts into one event, and unwatches', async () => {
    vi.useFakeTimers()
    try {
      const emitted: BeadsChangedEvent[] = []
      const { host, watchCallbacks, stopWatch } = fakeHost()
      const beads = service(host, emitted)
      await beads.watch(ROOT)
      await beads.watch(ROOT)
      expect(watchCallbacks).toHaveLength(1)

      watchCallbacks[0]?.({})
      watchCallbacks[0]?.({})
      watchCallbacks[0]?.({})
      expect(emitted).toHaveLength(0)
      vi.advanceTimersByTime(300)
      expect(emitted).toEqual([{ root: ROOT }])

      beads.unwatch(ROOT)
      expect(stopWatch).toHaveBeenCalledTimes(1)
      watchCallbacks[0]?.({})
      vi.advanceTimersByTime(300)
      expect(emitted).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a watch when .beads is absent', async () => {
    const { host, watch } = fakeHost({ statType: 'missing' })
    const beads = service(host)
    await beads.watch(ROOT)
    expect(watch).not.toHaveBeenCalled()
  })

  it('disposes every active watch', async () => {
    const { host, stopWatch } = fakeHost()
    const beads = service(host)
    await beads.watch(ROOT)
    beads.dispose()
    expect(stopWatch).toHaveBeenCalledTimes(1)
  })
})

describe('classifyListFailure', () => {
  it('flags every unreachable-server phrasing bd emits, and only those', () => {
    for (const stderr of [
      'dial tcp 127.0.0.1:0: connect: connection refused',
      'Dolt server: not reachable (external)',
      'auto-start is disabled (dolt.auto-start: false)',
      'auto-start is suppressed because the server is externally managed',
    ]) {
      expect(classifyListFailure(ROOT, stderr, 1).reason).toBe('server-unreachable')
    }
  })

  it('keeps no-database and generic failures distinct from unreachable', () => {
    expect(classifyListFailure(ROOT, 'no beads project found', 1).reason).toBe('no-database')
    const generic = classifyListFailure(ROOT, 'dolt server exploded', 2)
    expect(generic).toMatchObject({ reason: 'error', message: 'dolt server exploded' })
  })
})

describe('parseBeadsListOutput', () => {
  it('parses an empty result and tolerates whitespace', () => {
    expect(parseBeadsListOutput('')).toEqual([])
    expect(parseBeadsListOutput('  [] \n')).toEqual([])
  })

  it('maps snake_case fields and defaults optional ones', () => {
    const [issue] = parseBeadsListOutput(
      JSON.stringify([
        issueJson({
          acceptance_criteria: 'It works.',
          assignee: 'stephanie',
          parent: 'demo-epic',
          close_reason: '',
        }),
      ]),
    )
    expect(issue).toMatchObject({
      acceptanceCriteria: 'It works.',
      assignee: 'stephanie',
      parent: 'demo-epic',
      closeReason: undefined,
    })
  })

  it('fails fast on structurally invalid issues', () => {
    expect(() => parseBeadsListOutput('{"not":"a list"}')).toThrow(/not an issue list/)
    expect(() => parseBeadsListOutput('[{"title":"missing id"}]')).toThrow(
      /missing an id/,
    )
    expect(() => parseBeadsListOutput('[{"id":"x"}]')).toThrow(/title or status/)
  })
})

describe('parseDigraphEdges', () => {
  it('reads blocker→blocked edges, skipping blank and single-token lines', () => {
    const edges = parseDigraphEdges('gc-a gc-b gc-c\n\ngc-d\ngc-b gc-e\n')
    expect(edges).toEqual([
      { blockerId: 'gc-a', blockedId: 'gc-b' },
      { blockerId: 'gc-a', blockedId: 'gc-c' },
      { blockerId: 'gc-b', blockedId: 'gc-e' },
    ])
  })

  it('returns no edges for empty output', () => {
    expect(parseDigraphEdges('')).toEqual([])
  })
})

describe('parseGatesOutput', () => {
  it('parses gates and tolerates field-name variants', () => {
    const gates = parseGatesOutput(
      JSON.stringify([
        { id: 'g1', title: 'Approve release', gate_type: 'human', blocked_id: 'gc-x', state: 'open' },
        { id: 'g2', title: 'CI', type: 'gh:run', issue_id: 'gc-y', status: 'open' },
        { title: 'no id, dropped' },
      ]),
    )
    expect(gates).toEqual([
      { id: 'g1', title: 'Approve release', gateType: 'human', blockedId: 'gc-x', state: 'open' },
      { id: 'g2', title: 'CI', gateType: 'gh:run', blockedId: 'gc-y', state: 'open' },
    ])
  })

  it('returns no gates for non-array or invalid output', () => {
    expect(parseGatesOutput('not json')).toEqual([])
    expect(parseGatesOutput('{}')).toEqual([])
  })
})

describe('parseDispatchableOutput', () => {
  it('accepts an id array, an object array, and newline-delimited forms', () => {
    expect(parseDispatchableOutput('["gc-a","gc-b"]')).toEqual(['gc-a', 'gc-b'])
    expect(parseDispatchableOutput('[{"id":"gc-a"},{"id":"gc-c"}]')).toEqual(['gc-a', 'gc-c'])
    expect(parseDispatchableOutput('{"id":"gc-a"}\n{"id":"gc-b"}')).toEqual(['gc-a', 'gc-b'])
    expect(parseDispatchableOutput('gc-a\ngc-b')).toEqual(['gc-a', 'gc-b'])
  })

  it('is empty for empty output', () => {
    expect(parseDispatchableOutput('')).toEqual([])
  })
})

describe('BeadsService.list enrichment', () => {
  function enrichedHost(overrides: {
    readonly base: Record<string, unknown>[]
    readonly ready: Record<string, unknown>[]
    readonly digraph?: string
    readonly gates?: Record<string, unknown>[]
    readonly hasPredicate?: boolean
    readonly jq?: () => ExecResult
  }) {
    return fakeHost({
      statType: overrides.hasPredicate ? 'file' : 'missing',
      exec: (command, args) => {
        if (command === 'jq') return overrides.jq?.() ?? execResult(0, '[]')
        if (args.includes('gate')) return execResult(0, JSON.stringify(overrides.gates ?? []))
        if (args.includes('digraph')) return execResult(0, overrides.digraph ?? '')
        if (args.includes('--ready')) return execResult(0, JSON.stringify(overrides.ready))
        return execResult(0, JSON.stringify(overrides.base))
      },
    })
  }

  it('derives dispatchable structurally when no predicate is configured', async () => {
    // 3 dependency-ready, but only the executable-leaf ones are dispatchable.
    const { host } = enrichedHost({
      base: [
        issueJson({ id: 'leaf-1', issue_type: 'task' }),
        issueJson({ id: 'epic-1', issue_type: 'epic' }),
        issueJson({ id: 'convoy-1', issue_type: 'convoy' }),
      ],
      ready: [
        issueJson({ id: 'leaf-1', issue_type: 'task' }),
        issueJson({ id: 'epic-1', issue_type: 'epic' }),
        issueJson({ id: 'convoy-1', issue_type: 'convoy' }),
      ],
    })
    const result = await service(host).list({ root: ROOT })
    if (!result.available) throw new Error('expected availability')
    expect(result.readyIds).toEqual(['leaf-1', 'epic-1', 'convoy-1'])
    expect(result.dispatchableIds).toEqual(['leaf-1'])
    expect(result.dispatchabilitySource).toBe('structural')
  })

  it('uses a configured predicate and trusts its output', async () => {
    const { host, exec } = enrichedHost({
      base: [issueJson({ id: 'leaf-1' }), issueJson({ id: 'leaf-2' })],
      ready: [issueJson({ id: 'leaf-1' }), issueJson({ id: 'leaf-2' })],
      hasPredicate: true,
      jq: () => execResult(0, '["leaf-2"]'),
    })
    const result = await service(host).list({ root: ROOT })
    if (!result.available) throw new Error('expected availability')
    expect(result.dispatchableIds).toEqual(['leaf-2'])
    expect(result.dispatchabilitySource).toBe('predicate')
    expect(exec.mock.calls.some(([command]) => command === 'jq')).toBe(true)
  })

  it('falls back to structural when the predicate errors', async () => {
    const { host } = enrichedHost({
      base: [issueJson({ id: 'leaf-1', issue_type: 'bug' })],
      ready: [issueJson({ id: 'leaf-1', issue_type: 'bug' })],
      hasPredicate: true,
      jq: () => execResult(3, '', 'jq: error'),
    })
    const result = await service(host).list({ root: ROOT })
    if (!result.available) throw new Error('expected availability')
    expect(result.dispatchableIds).toEqual(['leaf-1'])
    expect(result.dispatchabilitySource).toBe('structural')
  })

  it('attaches dependency edges and gates', async () => {
    const { host } = enrichedHost({
      base: [issueJson({ id: 'gc-a' }), issueJson({ id: 'gc-b' })],
      ready: [],
      digraph: 'gc-a gc-b',
      gates: [{ id: 'g1', title: 'Approve', gate_type: 'human', blocked_id: 'gc-a', state: 'open' }],
    })
    const result = await service(host).list({ root: ROOT })
    if (!result.available) throw new Error('expected availability')
    expect(result.dependencies).toEqual([{ blockerId: 'gc-a', blockedId: 'gc-b' }])
    expect(result.gates).toEqual([
      { id: 'g1', title: 'Approve', gateType: 'human', blockedId: 'gc-a', state: 'open' },
    ])
  })

  it('degrades supplementary failures without failing the snapshot', async () => {
    const { host } = fakeHost({
      statType: 'missing',
      exec: (_command, args) => {
        if (args.includes('gate')) return execResult(1, '', 'gate boom')
        if (args.includes('digraph')) return Promise.reject(new Error('digraph boom'))
        if (args.includes('--ready')) return execResult(0, '[]')
        return execResult(0, JSON.stringify([issueJson({ id: 'gc-a' })]))
      },
    })
    const result = await service(host).list({ root: ROOT })
    if (!result.available) throw new Error('expected availability')
    expect(result.issues.map((i) => i.id)).toEqual(['gc-a'])
    expect(result.dependencies).toEqual([])
    expect(result.gates).toEqual([])
  })
})
