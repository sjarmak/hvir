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
  const context = { DependencyPackage: undefined as unknown, Date, Set, Map, URL }
  runInNewContext(result.outputFiles[0]!.text, context)
  return context.DependencyPackage as DependencyPackage
}

const api = packageApi()
const gcRig = {
  observedAt: 1,
  text: '{"ok":true,"city_path":"/city","rig":{"name":"city","path":"/city"}}',
}

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
        text: 'blocker work\nwork downstream-1 downstream-2\n',
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

  it('preserves every dependency edge from digraph adjacency rows', () =>
    hegel.test((tc) => {
      const rows = tc.draw(
        gs.arrays(
          gs.tuples(
            gs.fromRegex('[A-Za-z0-9][A-Za-z0-9._:-]{0,40}'),
            gs.arrays(gs.fromRegex('[A-Za-z0-9][A-Za-z0-9._:-]{0,40}'), {
              minSize: 1,
              maxSize: 8,
            }),
          ),
          { maxSize: 30 },
        ),
      )
      const parsed = api.parseDependencyEdges(
        rows.map(([blocker, blocked]) => [blocker, ...blocked].join(' ')).join('\n'),
        1,
      )
      expect(parsed.edges).toEqual(
        rows.flatMap(([blockerId, blocked]) =>
          blocked.map((blockedId) => ({ blockerId, blockedId })),
        ),
      )
    }))

  it.each([
    [
      'truncation',
      { outcome: 'completed', code: 0, truncated: true },
      'bd output was truncated',
    ],
    [
      'command failure',
      { outcome: 'completed', code: 2, truncated: false, reason: 'graph failed' },
      'graph failed',
    ],
  ])(
    'keeps dependency %s separate and preserves prior facts',
    async (_, result, message) => {
      const client = {
        request(capability: string, input: unknown) {
          expect(capability).toBe('connector.execute')
          const request = input as { args: string[] }
          if (request.args.includes('digraph')) return Promise.resolve(result)
          return Promise.resolve({ outcome: 'completed', code: 0, truncated: false })
        },
      }
      const previous = api.buildReadSurface({
        bd: {
          text: JSON.stringify([issue('blocker', 'open'), issue('work', 'open')]),
          observedAt: 1,
        },
        bdReady: { text: '[]', observedAt: 1 },
        bdDependencies: { text: 'blocker work', observedAt: 1 },
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
