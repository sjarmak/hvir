import { readFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'

interface BeadsPackage {
  commandForAction(action: string, input: unknown): [string, string[]]
  buildReadSurface(input: {
    bd?: { text: string; observedAt: number }
    bdFailure?: { message: string; observedAt: number }
    gc?: { text: string; observedAt: number }
    gcFailure?: { message: string; observedAt: number }
    previous?: unknown
  }): {
    beads: {
      state: string
      sections: readonly {
        key: string
        count: number
        items?: readonly { id: string }[]
      }[]
      message?: string
    }
    crew: {
      state: string
      groups: readonly {
        key: string
        members: readonly { bead?: { id: string }; held: readonly { id: string }[] }[]
      }[]
      message?: string
    }
  }
  createRefreshController(options: {
    refresh(): Promise<unknown>
    publish(value: unknown): void
    schedule(callback: () => void, delay: number): number
    cancel(timer: number): void
  }): {
    setVisible(visible: boolean): void
    request(): void
    dispose(): void
  }
}

function packageApi(): BeadsPackage {
  const result = buildSync({
    stdin: {
      contents:
        "export * from './packages/beads-extension/src/model.mjs'; export * from './packages/beads-extension/src/refresh.mjs'; export * from './packages/beads-extension/src/actions.mjs'",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'iife',
    globalName: 'BeadsPackage',
    write: false,
  })
  const context = { BeadsPackage: undefined as unknown, Date, Set, Map }
  runInNewContext(result.outputFiles[0]!.text, context)
  return context.BeadsPackage as BeadsPackage
}

const api = packageApi()

describe('Beads workspace extension package', () => {
  it('declares one left workspace view, one updater, and bounded bd and gc connectors', () => {
    const manifest = validateExtensionManifest(
      JSON.parse(readFileSync('packages/beads-extension/hvir-extension.json', 'utf8')),
    ).manifest
    expect(manifest.id).toBe('beads-extension')
    expect(manifest.requiredCapabilities).toEqual(
      expect.arrayContaining(['actions.invoke', 'terminal.start']),
    )
    expect(manifest.actions!.map((action) => action.id)).toEqual([
      'bead-claim',
      'bead-close',
      'bead-create',
      'crew-attach',
      'crew-peek',
      'crew-reset',
      'crew-handoff',
    ])
    expect(
      manifest.views.map((view) => [view.id, view.placement, view.navigation]),
    ).toEqual([['beads', 'workspace', 'left']])
    expect(manifest.updater).toBe('updater.html')
    expect(
      manifest.connectors?.map((connector) => [
        connector.id,
        connector.context,
        connector.setup,
      ]),
    ).toEqual([
      ['bd', 'workspace', { executable: 'bd' }],
      ['gc', 'workspace', { executable: 'gc' }],
    ])
    expect(manifest.requiredCapabilities).not.toContain('project.watch')
    for (const entry of [...manifest.views.map((view) => view.entry), manifest.updater])
      expect(readFileSync(`packages/beads-extension/${entry}`, 'utf8')).toContain(
        'script',
      )
  })

  it('reproduces the browser bundles byte for byte', () => {
    for (const [source, output] of [
      ['app', 'beads'],
      ['updater', 'updater'],
    ]) {
      const result = buildSync({
        entryPoints: [`packages/beads-extension/src/${source}.mjs`],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        write: false,
        minify: true,
        legalComments: 'none',
        charset: 'utf8',
      })
      expect(result.outputFiles[0]!.text).toBe(
        readFileSync(`packages/beads-extension/${output}.js`, 'utf8'),
      )
    }
    const styles = buildSync({
      entryPoints: ['packages/beads-extension/src/beads.css'],
      bundle: true,
      minify: true,
      legalComments: 'none',
      write: false,
    })
    expect(styles.outputFiles[0]!.text).toBe(
      readFileSync('packages/beads-extension/beads.css', 'utf8'),
    )
  })

  it('uses typed taxonomy for sections and joins exact crew identities', () => {
    const view = api.buildReadSurface({
      bd: {
        observedAt: 100,
        text: JSON.stringify([
          issue('task-1', 'task', 'open'),
          issue('ask-1', 'decision', 'open'),
          issue('run-1', 'bug', 'in_progress', { assignee: 'gc-worker' }),
          issue('held-1', 'chore', 'open', {
            assignee: 'gc-worker',
            dependency_count: 1,
          }),
          issue('epic-1', 'epic', 'open'),
          issue('convoy-1', 'convoy', 'open'),
          issue('unknown-1', 'future-kind', 'open'),
        ]),
      },
      gc: {
        observedAt: 101,
        text: JSON.stringify({
          ok: true,
          sessions: [
            {
              id: 'gc-worker',
              name: 'worker-1',
              template: '/agents/worker',
              state: 'active',
            },
            { id: 'gc-lead', name: 'lead', alias: 'lead', state: 'active' },
            {
              id: 'gc-internal',
              name: 'rig/control',
              alias: 'rig/control',
              state: 'active',
            },
            {
              id: 'gc-control',
              name: 'core.control-dispatcher',
              alias: 'core.control-dispatcher',
              state: 'active',
            },
          ],
        }),
      },
    })
    expect(
      Object.fromEntries(
        view.beads.sections.map((section) => [section.key, section.count]),
      ),
    ).toMatchObject({
      'needs-you': 1,
      'in-flight': 1,
      'dependency-ready': 1,
      planned: 1,
      blocked: 1,
      'data-hygiene': 1,
    })
    expect(view.beads.sections.some((section) => section.key === 'orchestration')).toBe(
      false,
    )
    expect(view.crew.groups.map((group) => group.key)).toEqual([
      'leads',
      'workers',
      'internals',
    ])
    const worker = view.crew.groups.find((group) => group.key === 'workers')?.members[0]
    expect(worker?.bead?.id).toBe('run-1')
    expect(worker?.held.map((bead) => bead.id)).toEqual(['held-1'])
    expect(
      view.crew.groups.find((group) => group.key === 'internals')?.members,
    ).toMatchObject([{ id: 'gc-internal' }, { id: 'gc-control' }])
  })

  it('places every visible typed issue in exactly one section', () =>
    hegel.test((tc) => {
      const rows = tc.draw(
        gs.arrays(
          gs.tuples(
            gs.sampledFrom([
              'task',
              'bug',
              'chore',
              'decision',
              'epic',
              'merge-request',
              'convoy',
              'gate',
              'agent',
              'future-kind',
            ]),
            gs.sampledFrom(['open', 'in_progress', 'blocked', 'deferred', 'closed']),
            gs.integers({ minValue: 0, maxValue: 2 }),
          ),
          { maxSize: 40 },
        ),
      )
      const issues = rows.map(([type, status, dependencies], index) =>
        issue(`generated-${index}`, type, status, { dependency_count: dependencies }),
      )
      const view = api.buildReadSurface({
        bd: { text: JSON.stringify(issues), observedAt: 1 },
        gc: { text: '{"ok":true,"sessions":[]}', observedAt: 1 },
      })
      const placed = view.beads.sections.flatMap((section) => section.items ?? [])
      const visible = issues.filter(
        (row) => !['convoy', 'gate', 'agent'].includes(String(row['issue_type'])),
      )
      expect(placed.map((row) => row.id).sort()).toEqual(
        visible.map((row) => row['id']).sort(),
      )
    }))

  it('preserves every admitted bead id as one structured argv value', () =>
    hegel.test((tc) => {
      const id = tc.draw(gs.fromRegex('[A-Za-z0-9][A-Za-z0-9._:-]{0,80}'))
      expect(api.commandForAction('bead-claim', { id })).toEqual([
        'bd',
        ['update', id, '--claim'],
      ])
      expect(api.commandForAction('bead-close', { id })).toEqual([
        'bd',
        ['close', id],
      ])
    }))

  it('keeps malformed, unavailable, and failed reads distinct from successful emptiness', () => {
    const empty = api.buildReadSurface({
      bd: { text: '[]', observedAt: 1 },
      gc: { text: '{"ok":true,"sessions":[]}', observedAt: 1 },
    })
    expect(empty.beads.state).toBe('empty')
    expect(empty.crew.state).toBe('empty')
    const failed = api.buildReadSurface({
      bdFailure: { message: 'bd deadline', observedAt: 2 },
      gc: { text: '{', observedAt: 2 },
      previous: empty,
    })
    expect(failed.beads).toMatchObject({ state: 'error', message: 'bd deadline' })
    expect(failed.crew.state).toBe('error')
    expect(failed.crew.message).toMatch(/structured gc output/)
  })

  it('refreshes immediately while visible, backs off unchanged and failed reads, and honors Refresh', async () => {
    let scheduled: (() => void) | undefined
    const delays: number[] = []
    const refresh = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ revision: 1, observedAt: 100 })
      .mockResolvedValueOnce({ revision: 1, observedAt: 200 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ revision: 2 })
    const publish = vi.fn()
    const cancel = vi.fn()
    const controller = api.createRefreshController({
      refresh,
      publish,
      schedule(callback, delay) {
        scheduled = callback
        delays.push(delay)
        return delays.length
      },
      cancel,
    })
    const settle = async (): Promise<void> => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
    controller.setVisible(true)
    await settle()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([5000])
    scheduled?.()
    await settle()
    expect(delays).toEqual([5000, 10_000])
    scheduled?.()
    await settle()
    expect(delays).toEqual([5000, 10_000, 20_000])
    controller.request()
    await settle()
    expect(refresh).toHaveBeenCalledTimes(4)
    expect(delays.at(-1)).toBe(5000)
    expect(publish).toHaveBeenCalledTimes(3)
    controller.setVisible(false)
    scheduled?.()
    await settle()
    expect(refresh).toHaveBeenCalledTimes(4)
    expect(cancel).toHaveBeenCalled()
    controller.setVisible(true)
    expect(refresh).toHaveBeenCalledTimes(5)
    controller.dispose()
  })

  it('starts a fresh read when demand returns before the hidden read settles', async () => {
    let finish!: (value: unknown) => void
    const refresh = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValueOnce({ revision: 2 })
    const controller = api.createRefreshController({
      refresh,
      publish: vi.fn(),
      schedule: vi.fn(() => 1),
      cancel: vi.fn(),
    })
    controller.setVisible(true)
    controller.setVisible(false)
    controller.setVisible(true)
    expect(refresh).toHaveBeenCalledTimes(1)
    finish({ revision: 1 })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
})

function issue(
  id: string,
  issueType: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: id,
    issue_type: issueType,
    status,
    priority: 2,
    labels: [],
    dependency_count: 0,
    dependent_count: 0,
    ...extra,
  }
}
