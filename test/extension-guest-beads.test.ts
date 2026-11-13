import { readFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { describe, expect, it, vi } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'

interface BeadsPackage {
  commandForAction(action: string, input: unknown): [string, string[]]
  beadEvalLink(
    metadata: Readonly<Record<string, string>> | undefined,
  ):
    | { kind: 'absent' }
    | { kind: 'invalid' }
    | { kind: 'available'; url: string; origin: string }
  packageAnalyticsUrl(configuration?: unknown): string | undefined
  sectionElement(
    document: Document,
    label: string,
    items: readonly {
      id: string
      title: string
      metadata?: Readonly<Record<string, string>>
    }[],
    count: number,
    openExternal: (url: string) => void,
    actions: (item: { id: string; title: string }) => HTMLElement,
    leading?: readonly HTMLElement[],
  ): HTMLElement
  buildReadSurface(input: {
    bd?: { text: string; observedAt: number }
    bdReady?: { text: string; observedAt: number }
    bdFailure?: { message: string; observedAt: number }
    gc?: { text: string; observedAt: number }
    gcRig?: { text: string; observedAt: number }
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
    gates: {
      state: string
      gates: readonly {
        gate: {
          id: string
          title: string
          gateType: string
          blockedId?: string
          state: string
        }
        blocks?: { id: string; title: string }
      }[]
      message?: string
    }
    crew: {
      state: string
      groups: readonly {
        key: string
        members: readonly {
          id: string
          bead?: { id: string }
          held: readonly { id: string }[]
        }[]
      }[]
      message?: string
    }
  }
  readWorkspace(
    client: {
      request(capability: string, input: unknown): Promise<unknown>
    },
    context: unknown,
    previous: unknown,
  ): Promise<unknown>
  createRefreshController(options: {
    refresh(): Promise<unknown>
    publish(value: unknown): void | Promise<void>
    fail(error: unknown): void
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
        "export * from './packages/beads-extension/src/model.mjs'; export * from './packages/beads-extension/src/refresh.mjs'; export * from './packages/beads-extension/src/actions.mjs'; export * from './packages/beads-extension/src/links.mjs'; export * from './packages/beads-extension/src/render.mjs'; export * from './packages/beads-extension/src/bridge.mjs'",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'iife',
    globalName: 'BeadsPackage',
    write: false,
  })
  const context = { BeadsPackage: undefined as unknown, Date, Set, Map, URL }
  runInNewContext(result.outputFiles[0]!.text, context)
  return context.BeadsPackage as BeadsPackage
}

const api = packageApi()
const cityRigSource = {
  observedAt: 1,
  text: JSON.stringify({
    ok: true,
    city_path: '/city',
    rig: { name: 'city', path: '/city' },
  }),
}

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
    expect(manifest.requiredCapabilities).toContain('external.open')
    for (const entry of [...manifest.views.map((view) => view.entry), manifest.updater])
      expect(readFileSync(`packages/beads-extension/${entry}`, 'utf8')).toContain(
        'script',
      )
  })

  it('accepts only bounded credential-free HTTPS evaluation destinations', () =>
    hegel.test((tc) => {
      const raw = tc.draw(gs.text({ maxSize: 2100 }))
      const result = api.beadEvalLink({ 'eval.run_url': raw })
      if (result.kind !== 'available') return
      const parsed = new URL(result.url)
      expect(result.url).toBe(raw)
      expect(parsed.protocol).toBe('https:')
      expect(parsed.username + parsed.password).toBe('')
      expect(result.url.length).toBeLessThanOrEqual(2048)
    }))

  it('keeps analytics unavailable without structured or package configuration', () => {
    expect(api.packageAnalyticsUrl()).toBeUndefined()
    expect(
      api.packageAnalyticsUrl({
        baseUrl: 'https://analytics.example',
        dashboardId: 'rig-health',
      }),
    ).toBe('https://analytics.example/dashboards/rig-health')
    expect(
      api.packageAnalyticsUrl({
        baseUrl: 'https://analytics.example',
        dashboardId: 123,
      }),
    ).toBeUndefined()
  })

  it('renders producer evaluation links and opens them through the public effect port', () => {
    const window = new Window()
    const openExternal = vi.fn()
    const section = api.sectionElement(
      window.document as unknown as Document,
      'Needs you',
      [
        {
          id: 'eval-1',
          title: 'Review evaluation',
          metadata: {
            'eval.run_url': 'https://results.example/runs/eval-1',
          },
        },
        {
          id: 'eval-2',
          title: 'Unsafe evaluation',
          metadata: { 'eval.run_url': 'javascript:alert(1)' },
        },
      ],
      2,
      openExternal,
      () => {
        const button = window.document.createElement('button')
        button.textContent = 'Claim'
        return button as unknown as HTMLElement
      },
    )
    const buttons = section.querySelectorAll('button[data-external-url]')
    expect(buttons).toHaveLength(1)
    expect(section.querySelector('[data-bead-id="eval-1"]')).not.toBeNull()
    expect(buttons[0]?.textContent).toBe('Evaluation')
    expect(section.textContent).toContain('Claim')
    expect(section.textContent).toContain('Evaluation link unavailable')
    buttons[0]?.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }) as unknown as MouseEvent,
    )
    expect(openExternal).toHaveBeenCalledWith('https://results.example/runs/eval-1')
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
      bdReady: {
        observedAt: 100,
        text: JSON.stringify([issue('task-1', 'task', 'open')]),
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
      gcRig: cityRigSource,
    })
    expect(
      Object.fromEntries(
        view.beads.sections.map((section) => [section.key, section.count]),
      ),
    ).toMatchObject({
      'needs-you': 1,
      'in-flight': 1,
      'dependency-ready': 1,
      planned: 2,
      blocked: 0,
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

  it('shows only sessions belonging to the selected rig', () => {
    const view = api.buildReadSurface({
      bd: { observedAt: 100, text: '[]' },
      bdReady: { observedAt: 100, text: '[]' },
      gc: {
        observedAt: 101,
        text: JSON.stringify({
          ok: true,
          sessions: [
            {
              id: 'gc-hvir-worker',
              name: 'hvir-worker-pool',
              template: '/projects/hvir/hvir-worker',
              work_dir: '/worktrees/hvir-worker-1',
              state: 'active',
            },
            {
              id: 'gc-hvir-lead',
              name: 'hvir-pl',
              alias: 'hvir-pl',
              template: 'hvir-pl',
              work_dir: '/projects/hvir',
              state: 'active',
            },
            {
              id: 'gc-hvir-internal',
              name: 'hvir/core.control-dispatcher',
              alias: 'hvir/core.control-dispatcher',
              template: 'hvir/core.control-dispatcher',
              work_dir: '/projects/hvir',
              state: 'active',
            },
            {
              id: 'gc-foreign',
              name: 'mem-pl',
              alias: 'mem-pl',
              template: 'mem-pl',
              work_dir: '/projects/mem',
              state: 'active',
            },
          ],
        }),
      },
      gcRig: {
        observedAt: 101,
        text: JSON.stringify({
          ok: true,
          city_path: '/city',
          rig: { name: 'hvir', path: '/projects/hvir' },
        }),
      },
    })
    expect(
      view.crew.groups.flatMap((group) =>
        group.members.map((member) => member.id),
      ),
    ).toEqual(['gc-hvir-lead', 'gc-hvir-worker', 'gc-hvir-internal'])
  })

  it('keeps foreign sessions out of every scoped crew group', () =>
    hegel.test((tc) => {
      const suffixes = tc.draw(
        gs.arrays(gs.fromRegex('[a-z][a-z0-9-]{0,20}'), { maxSize: 30 }),
      )
      const view = api.buildReadSurface({
        bd: { observedAt: 1, text: '[]' },
        bdReady: { observedAt: 1, text: '[]' },
        gc: {
          observedAt: 1,
          text: JSON.stringify({
            ok: true,
            sessions: [
              {
                id: 'own-worker',
                name: 'hvir-worker',
                template: '/projects/hvir/hvir-worker',
                work_dir: '/worktrees/hvir-worker',
                state: 'active',
              },
              ...suffixes.map((suffix, index) => ({
                id: `foreign-${index}`,
                name: `foreign-${suffix}`,
                template: `/projects/foreign/${suffix}`,
                work_dir: `/projects/foreign/${suffix}`,
                state: 'active',
              })),
            ],
          }),
        },
        gcRig: {
          observedAt: 1,
          text: JSON.stringify({
            ok: true,
            city_path: '/city',
            rig: { name: 'hvir', path: '/projects/hvir' },
          }),
        },
      })
      expect(
        view.crew.groups.flatMap((group) =>
          group.members.map((member) => member.id),
        ),
      ).toEqual(['own-worker'])
    }))

  it('keeps the city workspace city-wide and fails closed without a valid rig', () => {
    const gc = {
      observedAt: 1,
      text: JSON.stringify({
        ok: true,
        sessions: [
          {
            id: 'hvir-lead',
            name: 'hvir-pl',
            alias: 'hvir-pl',
            work_dir: '/projects/hvir',
            state: 'active',
          },
          {
            id: 'mem-lead',
            name: 'mem-pl',
            alias: 'mem-pl',
            work_dir: '/projects/mem',
            state: 'active',
          },
        ],
      }),
    }
    const city = api.buildReadSurface({
      bd: { observedAt: 1, text: '[]' },
      bdReady: { observedAt: 1, text: '[]' },
      gc,
      gcRig: {
        observedAt: 1,
        text: JSON.stringify({
          ok: true,
          city_path: '/city',
          rig: { name: 'city', path: '/city' },
        }),
      },
    })
    expect(
      city.crew.groups.flatMap((group) =>
        group.members.map((member) => member.id),
      ),
    ).toEqual(['hvir-lead', 'mem-lead'])

    const unknown = api.buildReadSurface({
      bd: { observedAt: 1, text: '[]' },
      bdReady: { observedAt: 1, text: '[]' },
      gc,
      gcRig: { observedAt: 1, text: '{"ok":false}' },
    })
    expect(unknown.crew).toMatchObject({
      state: 'error',
      message: 'Invalid structured gc output',
    })

    const missing = api.buildReadSurface({
      bd: { observedAt: 1, text: '[]' },
      bdReady: { observedAt: 1, text: '[]' },
      gc,
    })
    expect(missing.crew).toMatchObject({
      state: 'error',
      message: 'Invalid structured gc output',
    })
  })

  it('treats a bead with only closed dependencies as dependency-ready', () => {
    const row = issue('ready-after-close', 'task', 'open', { dependency_count: 1 })
    const view = api.buildReadSurface({
      bd: { observedAt: 100, text: JSON.stringify([row]) },
      bdReady: { observedAt: 100, text: JSON.stringify([row]) },
      gc: { observedAt: 100, text: '{"ok":true,"sessions":[]}' },
      gcRig: cityRigSource,
    })
    expect(
      view.beads.sections.find((section) => section.key === 'dependency-ready')
        ?.items,
    ).toMatchObject([{ id: 'ready-after-close' }])
    expect(
      view.beads.sections.find((section) => section.key === 'blocked')?.count,
    ).toBe(0)
  })

  it.each([
    ['epic-ready', 'epic', { 'gc.outcome': 'pass' }],
    ['merge-ready', 'merge-request', {}],
  ])('keeps ready non-leaf %s work out of Blocked', (id, issueType, metadata) => {
    const row = issue(id, issueType, 'open', {
      dependency_count: 1,
      metadata,
    })
    const view = api.buildReadSurface({
      bd: { observedAt: 100, text: JSON.stringify([row]) },
      bdReady: { observedAt: 100, text: JSON.stringify([row]) },
      gc: { observedAt: 100, text: '{"ok":true,"sessions":[]}' },
      gcRig: cityRigSource,
    })

    expect(
      view.beads.sections.find((section) => section.key === 'ready-to-ship')?.items,
    ).toMatchObject([{ id }])
    expect(
      view.beads.sections.find((section) => section.key === 'blocked')?.count,
    ).toBe(0)
  })

  it('reads the authoritative ready set through the bounded bd connector', async () => {
    const calls: { connector: string; args: string[] }[] = []
    const client = {
      request(capability: string, input: unknown) {
        expect(capability).toBe('connector.execute')
        const request = input as { connector: string; args: string[] }
        calls.push(request)
        return Promise.resolve({ outcome: 'completed', code: 0, truncated: false })
      },
    }
    await api.readWorkspace(
      client,
      { workspace: { host: 'local', id: 'workspace-1' } },
      undefined,
    )
    expect(
      calls.filter((call) => call.connector === 'bd').map((call) => call.args),
    ).toEqual([
      [
        'list',
        '--json',
        '--flat',
        '--no-pager',
        '-n',
        '0',
        '--include-gates',
        '--include-infra',
      ],
      [
        'list',
        '--ready',
        '--json',
        '--flat',
        '--no-pager',
        '-n',
        '0',
        '--include-gates',
        '--include-infra',
      ],
      [
        'list',
        '--format',
        '{{.IssueID}} dependsOn {{.DependsOnID}} {{.Type}}',
        '--no-pager',
        '-n',
        '500',
      ],
      ['gate', 'list', '--json'],
    ])
    expect(
      calls.filter((call) => call.connector === 'gc').map((call) => call.args),
    ).toEqual([
      ['session', 'list', '--json'],
      ['rig', 'status', '--json'],
    ])
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
        bdReady: {
          text: JSON.stringify(
            issues.filter(
              (row) => row['status'] === 'open' && row['dependency_count'] === 0,
            ),
          ),
          observedAt: 1,
        },
        gc: { text: '{"ok":true,"sessions":[]}', observedAt: 1 },
        gcRig: cityRigSource,
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

  it.each(['crew-attach', 'crew-peek', 'crew-reset', 'crew-handoff'])(
    'rejects a leading-dash crew target for %s before constructing terminal argv',
    (action) => {
      expect(() => api.commandForAction(action, { target: '--help' })).toThrow(
        'Invalid command input',
      )
    },
  )

  it('keeps malformed, unavailable, and failed reads distinct from successful emptiness', () => {
    const empty = api.buildReadSurface({
      bd: { text: '[]', observedAt: 1 },
      bdReady: { text: '[]', observedAt: 1 },
      gc: { text: '{"ok":true,"sessions":[]}', observedAt: 1 },
      gcRig: cityRigSource,
    })
    expect(empty.beads.state).toBe('empty')
    expect(empty.gates.state).toBe('unavailable')
    expect(empty.crew.state).toBe('empty')
    const failed = api.buildReadSurface({
      bdFailure: { message: 'bd deadline', observedAt: 2 },
      gc: { text: '{', observedAt: 2 },
      gcRig: cityRigSource,
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
      fail: vi.fn(),
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
      fail: vi.fn(),
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
