import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { describe, expect, it, vi } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'

interface DependencyItem {
  id: string
  title: string
  status: string
  blockedBy: readonly { id: string; title: string; status: string }[]
  unlocks: readonly { id: string; title: string; status: string }[]
  unlocksCount: number
  nextUnblock?: { action: string; owner?: string }
}

interface DependencyPackage {
  parseDependencyEdges(
    text: string,
    observedAt: number,
  ): {
    state: string
    edges: readonly { blockerId: string; blockedId: string }[]
  }
  buildReadSurface(input: {
    bd?: { text: string; observedAt: number }
    bdReady?: { text: string; observedAt: number }
    bdDependencies?: { text: string; observedAt: number }
    bdDependenciesFailure?: { message: string; observedAt: number }
    gc?: { text: string; observedAt: number }
    gcRig?: { text: string; observedAt: number }
    previous?: unknown
  }): {
    beads: {
      sections: readonly { key: string; items: readonly DependencyItem[] }[]
    }
    dependencies: {
      state: string
      edges: readonly { blockerId: string; blockedId: string }[]
      message?: string
    }
  }
  readWorkspace(
    client: { request(capability: string, input: unknown): Promise<unknown> },
    context: unknown,
    previous: unknown,
  ): Promise<unknown>
  sectionElement(
    document: Document,
    label: string,
    items: readonly DependencyItem[],
    count: number,
    openExternal: (url: string) => void,
    actions: () => HTMLElement,
  ): HTMLElement
}

function packageApi(): DependencyPackage {
  const result = buildSync({
    stdin: {
      contents:
        "export * from './packages/beads-extension/src/model.mjs'; export * from './packages/beads-extension/src/render.mjs'; export * from './packages/beads-extension/src/bridge.mjs'",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'iife',
    globalName: 'DependencyPackage',
    write: false,
  })
  const context = {
    DependencyPackage: undefined as unknown,
    Date,
    Set,
    Map,
    URL,
    TextEncoder,
  }
  runInNewContext(result.outputFiles[0]!.text, context)
  return context.DependencyPackage as DependencyPackage
}

const api = packageApi()
const gcRig = {
  observedAt: 1,
  text: '{"ok":true,"city_path":"/city","rig":{"name":"city","path":"/city"}}',
}

const realTypedDependencies = [
  'hvir-0zd6s dependsOn hvir-b7vxq blocks',
  'hvir-0zd6s dependsOn hvir-ub3le blocks',
  'hvir-0zd6s dependsOn hvir-yvvr6 tracks',
  'hvir-3q34m dependsOn hvir-yvvr6 tracks',
  'hvir-6wpc8.26 dependsOn hvir-6wpc8 parent-child',
  'hvir-w00.5 dependsOn hvir-w00 parent-child',
].join('\n')

describe('Beads workspace dependencies', () => {
  it('restores blocker identity, unlocks, and the next unblock action', () => {
    const view = api.buildReadSurface({
      bd: {
        observedAt: 100,
        text: JSON.stringify([
          issue('blocker', 'in_progress', {
            title: 'Finish migration',
            assignee: 'worker-1',
          }),
          issue('work', 'open', { title: 'Ship release' }),
          issue('downstream-1', 'open', { title: 'Notify users' }),
          issue('downstream-2', 'open', { title: 'Close rollout' }),
        ]),
      },
      bdReady: { observedAt: 100, text: '[]' },
      bdDependencies: {
        observedAt: 101,
        text: [
          'work dependsOn blocker blocks',
          'downstream-1 dependsOn work blocks',
          'downstream-2 dependsOn work blocks',
          'work dependsOn blocker blocks',
          'work dependsOn work blocks',
          'outside dependsOn work blocks',
          'work dependsOn outside blocks',
          'work dependsOn downstream-1 tracks',
          'work dependsOn downstream-2 parent-child',
        ].join('\n'),
      },
      gc: { observedAt: 100, text: '{"ok":true,"sessions":[]}' },
      gcRig,
    })
    const blocked = view.beads.sections
      .find((section) => section.key === 'blocked')
      ?.items.find((item) => item.id === 'work')
    expect(blocked).toMatchObject({
      blockedBy: [{ id: 'blocker', title: 'Finish migration', status: 'in_progress' }],
      unlocks: [
        { id: 'downstream-1', title: 'Notify users', status: 'open' },
        { id: 'downstream-2', title: 'Close rollout', status: 'open' },
      ],
      unlocksCount: 2,
      nextUnblock: { action: 'Resolve “Finish migration”', owner: 'worker-1' },
    })
    const window = new Window()
    const section = api.sectionElement(
      window.document as unknown as Document,
      'Blocked',
      [blocked!],
      1,
      vi.fn(),
      () => window.document.createElement('span') as unknown as HTMLElement,
    )
    expect(section.textContent).toContain('Blocked by: Finish migration')
    expect(section.textContent).toContain('Unlocks 2: Notify users, Close rollout')
    expect(section.textContent).toContain(
      'Next unblock: Resolve “Finish migration” — worker-1',
    )
  })

  it('reads only unique non-self blocks edges from real typed bd output', () => {
    expect(api.parseDependencyEdges(realTypedDependencies, 1).edges).toEqual([
      { blockerId: 'hvir-b7vxq', blockedId: 'hvir-0zd6s' },
      { blockerId: 'hvir-ub3le', blockedId: 'hvir-0zd6s' },
    ])
  })

  it('preserves exactly the unique blocks relation from typed rows', () =>
    hegel.test((tc) => {
      const rows = tc.draw(
        gs.arrays(
          gs.tuples(
            gs.fromRegex('[A-Za-z0-9][A-Za-z0-9._:-]{0,40}'),
            gs.fromRegex('[A-Za-z0-9][A-Za-z0-9._:-]{0,40}'),
            gs.sampledFrom(['blocks', 'tracks', 'parent-child']),
          ),
          { maxSize: 30 },
        ),
      )
      const parsed = api.parseDependencyEdges(
        rows
          .map(([issueId, dependsOnId, type]) =>
            [issueId, 'dependsOn', dependsOnId, type].join(' '),
          )
          .join('\n'),
        1,
      )
      const expected = new Map<string, { blockerId: string; blockedId: string }>()
      for (const [blockedId, blockerId, type] of rows) {
        if (type !== 'blocks' || blockerId === blockedId) continue
        expected.set(`${blockerId}\0${blockedId}`, { blockerId, blockedId })
      }
      expect(parsed.edges).toEqual(
        [...expected.values()],
      )
    }))

  it('does not classify non-blocking dependency counts as Blocked', () => {
    const view = api.buildReadSurface({
      bd: {
        observedAt: 1,
        text: JSON.stringify([issue('tracked', 'open', { dependency_count: 1 })]),
      },
      bdReady: { observedAt: 1, text: '[]' },
      bdDependencies: {
        observedAt: 1,
        text: 'tracked dependsOn parent tracks',
      },
      gc: { observedAt: 1, text: '{"ok":true,"sessions":[]}' },
      gcRig,
    })
    expect(
      view.beads.sections.find((section) => section.key === 'blocked')?.items,
    ).toEqual([])
    expect(
      view.beads.sections.find((section) => section.key === 'planned')?.items,
    ).toMatchObject([{ id: 'tracked' }])
  })

  it.each([
    [
      'truncation',
      { outcome: 'completed', code: 0, truncated: true },
      'Dependency read failed: bd output was truncated',
    ],
    [
      'command failure',
      { outcome: 'completed', code: 2, truncated: false, reason: 'graph failed' },
      'Dependency read failed: graph failed',
    ],
  ])(
    'keeps dependency %s separate and preserves prior facts',
    async (_, result, message) => {
      const client = {
        request(capability: string, input: unknown) {
          expect(capability).toBe('connector.execute')
          const request = input as { args: string[] }
          if (request.args.includes('{{.IssueID}} dependsOn {{.DependsOnID}} {{.Type}}'))
            return Promise.resolve(result)
          return Promise.resolve({ outcome: 'completed', code: 0, truncated: false })
        },
      }
      const previous = api.buildReadSurface({
        bd: {
          text: JSON.stringify([issue('blocker', 'open'), issue('work', 'open')]),
          observedAt: 1,
        },
        bdReady: { text: '[]', observedAt: 1 },
        bdDependencies: { text: 'work dependsOn blocker blocks', observedAt: 1 },
        gc: { text: '{"ok":true,"sessions":[]}', observedAt: 1 },
        gcRig,
      })
      const input = (await api.readWorkspace(
        client,
        { workspace: { host: 'local', id: 'workspace-1' } },
        previous,
      )) as Parameters<DependencyPackage['buildReadSurface']>[0]
      const view = api.buildReadSurface({
        ...input,
        bd: {
          text: JSON.stringify([issue('blocker', 'open'), issue('work', 'open')]),
          observedAt: 2,
        },
        bdReady: { text: '[]', observedAt: 2 },
        gc: { text: '{"ok":true,"sessions":[]}', observedAt: 2 },
        gcRig,
      })
      expect(view.dependencies).toMatchObject({
        state: 'error',
        message,
        edges: [{ blockerId: 'blocker', blockedId: 'work' }],
      })
      expect(
        view.beads.sections.find((section) => section.key === 'blocked')?.items,
      ).toMatchObject([{ id: 'work' }])
    },
  )

  it('reports the bounded dependency row limit as a failed read', async () => {
    const text = Array.from(
      { length: 500 },
      (_, index) => `blocked-${String(index)} dependsOn blocker-${String(index)} blocks`,
    ).join('\n')
    const result = {
      receipt: 'dependency-output',
      outcome: 'completed',
      host: 'local',
      code: 0,
      signal: null,
      truncated: false,
      stdoutBytes: new TextEncoder().encode(text).byteLength,
      stderrBytes: 0,
    }
    const client = {
      request(capability: string, input: unknown) {
        const request = input as {
          args?: string[]
          receipt?: string
          release?: boolean
          stream?: string
        }
        if (capability === 'connector.execute') {
          if (request.args?.includes('{{.IssueID}} dependsOn {{.DependsOnID}} {{.Type}}'))
            return Promise.resolve(result)
          return Promise.resolve({ outcome: 'completed', code: 0, truncated: false })
        }
        if (request.release) return Promise.resolve(undefined)
        const data = request.stream === 'stderr' ? '' : text
        return Promise.resolve({ data, nextOffset: null, result })
      },
    }
    const input = (await api.readWorkspace(
      client,
      { workspace: { host: 'local', id: 'workspace-1' } },
      undefined,
    )) as Parameters<DependencyPackage['buildReadSurface']>[0]
    expect(input.bdDependenciesFailure?.message).toBe(
      'Dependency read failed: result reached the 500-edge limit',
    )
  })
})

function issue(
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: id,
    issue_type: 'task',
    status,
    priority: 2,
    labels: [],
    dependency_count: 0,
    dependent_count: 0,
    ...extra,
  }
}
