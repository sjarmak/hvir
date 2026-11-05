// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApplicationNavigation } from '../src/renderer/src/needs-you/use-application-navigation'
import { asHostId, hostPath, type ProjectState } from '../src/shared'

const root = hostPath(asHostId('local'), '/repo')
const otherRoot = hostPath(asHostId('ssh-a'), '/repo')
const target = { projectId: 'p', workspaceId: 'w', root, beadId: 'b' }
const state = {
  revision: 1,
  root,
  connectionState: 'connected',
  watchTier: 'full',
  projects: [{
    id: 'p',
    registeredRoot: root,
    displayName: 'Project',
    connectionState: 'connected',
    watchTier: 'full',
    activeWorkspaceId: 'w',
    workspaces: [{
      id: 'w', root, name: 'main', main: true, closed: false, missing: false,
      repository: true, changedFiles: 0,
    }],
  }],
  activeProjectId: 'p',
  activeWorkspaceId: 'w',
} as unknown as ProjectState

describe('application navigation', () => {
  let host: HTMLDivElement
  let rootNode: Root
  let navigation!: ReturnType<typeof useApplicationNavigation>
  let resolveSwitch!: () => void

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
  })

  function renderNavigation({
    currentRoot = root,
    switchWorkspace = vi.fn(() => Promise.resolve()),
  }: {
    readonly currentRoot?: typeof root
    readonly switchWorkspace?: (projectId: string, workspaceId: string) => Promise<void>
  } = {}): void {
    function Harness() {
      navigation = useApplicationNavigation({
        projectState: state,
        root: currentRoot,
        switchWorkspace,
        onError: vi.fn(),
      })
      return null
    }
    act(() => rootNode.render(<Harness />))
  }

  it('cancels a pending bead switch when the user changes destination', async () => {
    const switchWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveSwitch = resolve }))
    renderNavigation({ switchWorkspace })
    let pending!: Promise<boolean>
    act(() => { pending = navigation.needsYou.selectBead(target) })
    act(() => navigation.setDestination('sessions'))
    act(() => resolveSwitch())
    await expect(pending).resolves.toBe(false)
    expect(navigation.destination).toBe('sessions')
  })

  it('switches to the exact workspace without routing through the built-in beads rail', async () => {
    renderNavigation()
    await act(async () => {
      await navigation.needsYou.selectBead(target)
    })
    expect(navigation.destination).toBe('workspace')
    expect(navigation.beadTarget).toEqual(target)
  })

  it('does not expose a rail target while the active root is different', async () => {
    renderNavigation({ currentRoot: otherRoot })
    await act(async () => {
      await navigation.needsYou.selectBead(target)
    })
    expect(navigation.beadTarget).toBeUndefined()
  })

  it('keeps the extension target independent of the built-in rail', async () => {
    renderNavigation()
    await act(async () => {
      await navigation.needsYou.selectBead(target)
    })
    expect(navigation.beadTarget).toEqual(target)
  })

  it('reports an unavailable focused bead outside the state updater', async () => {
    const onError = vi.fn()
    function Harness() {
      navigation = useApplicationNavigation({
        projectState: state,
        root,
        switchWorkspace: () => Promise.resolve(),
        onError,
      })
      return null
    }
    act(() => rootNode.render(<Harness />))
    await act(async () => {
      await navigation.needsYou.selectBead(target)
    })
    act(() => navigation.needsYou.beadUnavailable(target.beadId))
    expect(navigation.beadTarget).toBeUndefined()
    expect(onError).toHaveBeenCalledWith('The Beads workspace view could not be opened.')
  })

  it('revokes a late switch after unmount', async () => {
    const switchWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveSwitch = resolve }))
    renderNavigation({ switchWorkspace })
    let pending!: Promise<boolean>
    act(() => { pending = navigation.needsYou.selectBead(target) })
    act(() => rootNode.unmount())
    act(() => resolveSwitch())
    await expect(pending).resolves.toBe(false)
  })
})
