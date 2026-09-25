// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectsBar } from '../src/renderer/src/workspaces/ProjectsBar'
import { localPath, type ProjectState, type WorkspaceState } from '../src/shared'

vi.mock('../src/renderer/src/health/WorkbenchHealthControl', () => ({
  WorkbenchHealthControl: () => null,
}))

const PROJECT = 'project:local:/repo'
const HANDOFF = 'workspace:local:/repo.hvir-worktrees/review-1'
const ACTIVE_HANDOFF = 'workspace:local:/repo.hvir-worktrees/review-2'

let host: HTMLDivElement
let root: Root
const invoke = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('hvir', { invoke })
  invoke.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('unfinished handoff workspaces', () => {
  it('labels the worktrees main reports and offers removal only off the active tab', async () => {
    respond({ handoffs: [HANDOFF, ACTIVE_HANDOFF] })
    await render(state())

    expect(invoke).toHaveBeenCalledWith('workspace:unfinished-handoffs', {
      projectId: PROJECT,
    })
    const handoff = tab('review-1')
    expect(handoff?.textContent).toContain('unfinished handoff')
    expect(tab('feature')?.textContent).not.toContain('unfinished handoff')
    expect(removeButton('review-1')?.disabled).toBe(false)
    expect(removeButton('review-2')?.disabled).toBe(true)
    expect(removeButton('review-2')?.title).toBe(
      'Select another workspace before removing this one',
    )
    expect(removeButton('feature')).toBeNull()
  })

  it('asks nothing of main when no workspace is on an architecture handoff branch', async () => {
    await render(state({ handoffBranches: false }))

    expect(invoke).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('unfinished handoff')
  })

  it('removes only after the person confirms, and cancel leaves it in place', async () => {
    respond({ handoffs: [HANDOFF] })
    await render(state())

    await click(removeButton('review-1'))
    expect(dialog()?.textContent).toContain('/repo.hvir-worktrees/review-1')
    expect(dialog()?.textContent).toContain('hvir/architecture/review-1')
    await click(dialogButton('Cancel'))
    expect(dialog()).toBeNull()
    expect(removed()).toHaveLength(0)

    await click(removeButton('review-1'))
    await click(dialogButton('Remove worktree and branch'))
    expect(removed()).toEqual([
      [
        'workspace:remove-unfinished-handoff',
        { projectId: PROJECT, workspaceId: HANDOFF },
      ],
    ])
    expect(dialog()).toBeNull()
  })

  it('keeps the dialog open with main’s refusal when the worktree no longer qualifies', async () => {
    respond({
      handoffs: [HANDOFF],
      removal: {
        ok: false,
        error: 'Cannot remove /repo.hvir-worktrees/review-1: it has changes',
      },
    })
    await render(state())

    await click(removeButton('review-1'))
    await click(dialogButton('Remove worktree and branch'))

    expect(dialog()?.textContent).toContain(
      'Cannot remove /repo.hvir-worktrees/review-1: it has changes',
    )
  })
})

function respond({
  handoffs,
  removal = { ok: true, value: state() },
}: {
  readonly handoffs: readonly string[]
  readonly removal?: unknown
}): void {
  invoke.mockImplementation((channel: string) =>
    Promise.resolve(
      channel === 'workspace:unfinished-handoffs'
        ? { ok: true, value: handoffs }
        : removal,
    ),
  )
}

function removed(): unknown[][] {
  return invoke.mock.calls.filter(
    ([channel]) => channel === 'workspace:remove-unfinished-handoff',
  )
}

async function render(next: ProjectState): Promise<void> {
  await act(async () => {
    root.render(
      <ProjectsBar
        state={next}
        rollups={{}}
        busy={false}
        onAdd={vi.fn()}
        onSwitch={vi.fn()}
        onRefresh={vi.fn()}
        onCloseProject={vi.fn()}
        onPrune={vi.fn()}
        onDismiss={vi.fn()}
        onPlanCloseWorkspace={vi.fn(() => Promise.resolve({ terminalCount: 0 }))}
        onCloseWorkspace={vi.fn()}
        onReopenWorkspace={vi.fn()}
        watchTier="native"
        onChangeConnection={vi.fn()}
        onDisconnect={vi.fn()}
        onReconnect={vi.fn()}
        theme="dark"
        onTheme={vi.fn()}
        onSettings={vi.fn()}
        sessionsActive={false}
        onSessions={vi.fn()}
      />,
    )
    await Promise.resolve()
  })
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => {
    element!.click()
    await Promise.resolve()
  })
}

function tab(name: string): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>('.workspace-tab')].find((candidate) =>
    candidate.querySelector('span')?.textContent?.endsWith(name),
  )
}

function removeButton(name: string): HTMLButtonElement | null {
  return tab(name)?.querySelector<HTMLButtonElement>('.workspace-remove-handoff') ?? null
}

function dialog(): HTMLElement | null {
  return document.querySelector('.unfinished-handoff-dialog')
}

function dialogButton(label: string): HTMLButtonElement | undefined {
  return [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent === label,
  )
}

function state({ handoffBranches = true } = {}): ProjectState {
  const workspace = (
    path: string,
    branch: string,
    extra: Partial<WorkspaceState> = {},
  ): WorkspaceState => ({
    id: `workspace:local:${path}`,
    root: localPath(path),
    name: branch,
    branch,
    head: 'a'.repeat(40),
    main: false,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: 0,
    ...extra,
  })
  const prefix = handoffBranches ? 'hvir/architecture/' : 'review/'
  const workspaces = [
    workspace('/repo', 'main', { main: true }),
    workspace('/repo/feature', 'feature'),
    workspace('/repo.hvir-worktrees/review-1', `${prefix}review-1`),
    workspace('/repo.hvir-worktrees/review-2', `${prefix}review-2`),
  ]
  return {
    revision: 0,
    root: localPath('/repo.hvir-worktrees/review-2'),
    activeProjectId: PROJECT,
    activeWorkspaceId: ACTIVE_HANDOFF,
    connectionState: 'connected',
    watchTier: 'native',
    projects: [
      {
        id: PROJECT,
        displayName: 'repo',
        registeredRoot: localPath('/repo'),
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: ACTIVE_HANDOFF,
        workspaces,
      },
    ],
  }
}
