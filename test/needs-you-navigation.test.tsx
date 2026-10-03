// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isNeedsYouWorkspaceTarget,
  useNeedsYouNavigation,
} from '../src/renderer/src/needs-you/use-needs-you-navigation'
import { useApplicationNavigation } from '../src/renderer/src/needs-you/use-application-navigation'
import { asHostId, hostPath, type ProjectState } from '../src/shared'

const root = hostPath(asHostId('local'), '/repo')
const otherHost = hostPath(asHostId('ssh-a'), '/repo')
const target = { projectId: 'p', workspaceId: 'w', root, beadId: 'b' }
const workspace = {
  id: 'w', root, name: 'main', main: true, closed: false, missing: false,
  repository: true, changedFiles: 0,
}
const project = {
  id: 'p', registeredRoot: root, displayName: 'Project', connectionState: 'connected',
  watchTier: 'full', activeWorkspaceId: 'w', workspaces: [workspace],
} as unknown as ProjectState['projects'][number]
const state = { revision: 1, root, connectionState: 'connected', watchTier: 'full',
  projects: [project], activeProjectId: 'p', activeWorkspaceId: 'w' } as unknown as ProjectState

describe('Needs you navigation authority', () => {
  it('requires exact project, workspace, host and path authority', () => {
    expect(isNeedsYouWorkspaceTarget(project, workspace, target)).toBe(true)
    expect(isNeedsYouWorkspaceTarget(undefined, workspace, target)).toBe(false)
    expect(isNeedsYouWorkspaceTarget(project, workspace, { ...target, projectId: 'other' })).toBe(false)
    expect(isNeedsYouWorkspaceTarget(project, workspace, { ...target, workspaceId: 'other' })).toBe(false)
    expect(isNeedsYouWorkspaceTarget(project, workspace, { ...target, root: otherHost })).toBe(false)
    expect(isNeedsYouWorkspaceTarget({ ...project, connectionState: 'disconnected' }, workspace, target)).toBe(false)
    expect(isNeedsYouWorkspaceTarget(project, { ...workspace, closed: true }, target)).toBe(false)
    expect(isNeedsYouWorkspaceTarget(project, { ...workspace, missing: true }, target)).toBe(false)
  })
})

describe('Needs you navigation cancellation', () => {
  let host: HTMLDivElement
  let rootNode: Root
  let navigation!: ReturnType<typeof useNeedsYouNavigation>
  let resolveSwitch!: () => void
  let rejectSwitch!: (reason: Error) => void
  const onWorkspace = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.append(host)
    rootNode = createRoot(host)
  })

  afterEach(() => {
    act(() => rootNode.unmount())
    host.remove()
    vi.unstubAllGlobals()
    onWorkspace.mockReset()
  })

  it('does not complete a stale target after leaving the view', () => {
    const switchWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveSwitch = resolve }))
    function Harness() {
      navigation = useNeedsYouNavigation({ projectState: state, switchWorkspace, onWorkspace, onError: vi.fn() })
      return null
    }
    act(() => rootNode.render(<Harness />))
    let selected = false
    act(() => { void navigation.selectBead(target).then((value) => { selected = value }) })
    expect(switchWorkspace).toHaveBeenCalledWith('p', 'w')
    act(() => { navigation.cancelPending() })
    act(() => resolveSwitch())
    expect(selected).toBe(false)
    expect(onWorkspace).not.toHaveBeenCalled()
  })

  it('rejects a target whose root is no longer authoritative', async () => {
    const switchWorkspace = vi.fn(() => Promise.resolve())
    function Harness() {
      navigation = useNeedsYouNavigation({ projectState: state, switchWorkspace, onWorkspace, onError: vi.fn() })
      return null
    }
    act(() => rootNode.render(<Harness />))
    await expect(navigation.selectBead({ ...target, root: otherHost })).rejects.toThrow(
      'That bead is no longer available in its workspace.',
    )
    expect(switchWorkspace).not.toHaveBeenCalled()
    expect(onWorkspace).not.toHaveBeenCalled()
  })

  it('clears a target when switching workspaces fails', async () => {
    const switchWorkspace = vi.fn(() => new Promise<void>((_, reject) => { rejectSwitch = reject }))
    function Harness() {
      navigation = useNeedsYouNavigation({ projectState: state, switchWorkspace, onWorkspace, onError: vi.fn() })
      return null
    }
    act(() => rootNode.render(<Harness />))
    let pending!: Promise<boolean>
    act(() => { pending = navigation.selectBead(target) })
    const rejection = expect(pending).rejects.toThrow('switch failed')
    await act(async () => {
      rejectSwitch(new Error('switch failed'))
      await pending.catch(() => undefined)
    })
    await rejection
    expect(navigation.beadTarget).toBeUndefined()
    expect(onWorkspace).not.toHaveBeenCalled()
  })

  it('does not let a superseding session selection steal the workspace', async () => {
    const switchWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveSwitch = resolve }))
    function Harness() {
      navigation = useNeedsYouNavigation({ projectState: state, switchWorkspace, onWorkspace, onError: vi.fn() })
      return null
    }
    act(() => rootNode.render(<Harness />))
    let pending!: Promise<boolean>
    act(() => { pending = navigation.selectBead(target) })
    act(() => navigation.selectSession({
      handle: 'session-1',
      title: 'Session',
      project: { id: 'p', name: 'Project' },
      workspace: { id: 'w', name: 'main' },
      host: { id: 'local', label: 'Local' },
      attention: { status: 'available', value: 'prompt' },
      connectionState: 'connected',
    } as never))
    act(() => resolveSwitch())
    await expect(pending).resolves.toBe(false)
    expect(onWorkspace).not.toHaveBeenCalled()
    expect(navigation.sessionTarget?.handle).toBe('session-1')
  })

  it('does not navigate after cancellation when a switch completes late', async () => {
    const switchWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveSwitch = resolve }))
    function Harness() {
      navigation = useNeedsYouNavigation({ projectState: state, switchWorkspace, onWorkspace, onError: vi.fn() })
      return null
    }
    act(() => rootNode.render(<Harness />))
    let pending!: Promise<boolean>
    act(() => { pending = navigation.selectBead(target) })
    act(() => navigation.cancelPending())
    act(() => resolveSwitch())
    await expect(pending).resolves.toBe(false)
    expect(onWorkspace).not.toHaveBeenCalled()
    expect(navigation.beadTarget).toBeUndefined()
  })
})

describe('application destination navigation', () => {
  it('preserves a selected session when the destination switch cancels pending navigation', () => {
    let navigation!: ReturnType<typeof useApplicationNavigation>
    const setRailMode = vi.fn()
    const onError = vi.fn()
    const switchWorkspace = vi.fn(() => Promise.resolve())
    const session = {
      handle: 'session-1',
      title: 'Session',
      project: { id: 'p', name: 'Project' },
      workspace: { id: 'w', name: 'main' },
      host: { id: 'local', label: 'Local' },
      attention: { status: 'available', value: 'prompt' },
      connectionState: 'connected',
    } as never

    function Harness() {
      navigation = useApplicationNavigation({
        projectState: state,
        root,
        switchWorkspace,
        onError,
        beadsEnabled: false,
        setRailMode,
      })
      return null
    }

    const host = document.createElement('div')
    const rootNode = createRoot(host)
    document.body.append(host)
    act(() => rootNode.render(<Harness />))
    act(() => {
      navigation.setDestination('sessions')
      navigation.needsYou.selectSession(session)
    })
    expect(navigation.destination).toBe('sessions')
    expect(navigation.needsYou.sessionTarget?.handle).toBe('session-1')
    act(() => rootNode.unmount())
    host.remove()
  })
})
