import { expect, it, vi } from 'vitest'
import { createWorkspaceSessionActions } from '../src/renderer/src/workspaces/workspace-session-actions'

const plan = { terminalCount: 0 } as never
const state = { projects: [] } as never

function actions(invoke: (channel: string) => Promise<unknown>) {
  vi.stubGlobal('window', { hvir: { invoke } })
  const onWorkspaceClosed = vi.fn()
  const subject = createWorkspaceSessionActions({
    runTransition: async (operation) => operation(),
    ensureProjectConnected: async () => undefined,
    reportError: () => undefined,
    onWorkspaceClosed,
  })
  return { subject, onWorkspaceClosed }
}

it('reports a closed workspace once main confirmed the close', async () => {
  const { subject, onWorkspaceClosed } = actions(async () => ({ ok: true, value: state }))
  await subject.closeWorkspace('p', 'w', plan, false)
  expect(onWorkspaceClosed).toHaveBeenCalledWith('p', 'w')
})

it('reports nothing when main refused the close', async () => {
  const { subject, onWorkspaceClosed } = actions(async () => ({
    ok: false,
    error: 'refused',
  }))
  await expect(subject.closeWorkspace('p', 'w', plan, false)).rejects.toThrow('refused')
  expect(onWorkspaceClosed).not.toHaveBeenCalled()
})
