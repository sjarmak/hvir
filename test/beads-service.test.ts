import { describe, expect, it, vi } from 'vitest'

import { BeadsService, parseBeadsListOutput } from '../src/main/beads/beads-service'
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
    expect(exec).toHaveBeenCalledTimes(2)
    const [command, args] = exec.mock.calls[0] as [string, readonly string[]]
    expect(command).toBe('bd')
    expect(args).toEqual(
      expect.arrayContaining(['-C', ROOT.path, 'list', '--json', '--flat', '-n', '0']),
    )
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
    expect(exec).toHaveBeenCalledTimes(3)
    expect(exec.mock.calls[2]?.[1]).toEqual(
      expect.arrayContaining(['--status', 'closed']),
    )
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
