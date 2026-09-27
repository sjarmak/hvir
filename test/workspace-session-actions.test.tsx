import { expect, it, vi } from 'vitest'
import { createWorkspaceSessionActions } from '../src/renderer/src/workspaces/workspace-session-actions'

const plan = { terminalCount: 0 } as never
const state = { projects: [] } as never

function actions(invoke: (channel: string) => Promise<unknown>) {
  vi.stubGlobal('window', { hvir: { invoke } })
  const onWorkspaceClosed = vi.fn()
  const subject = createWorkspaceSessionActions({
    runTransition: (operation) => operation(),
    ensureProjectConnected: () => Promise.resolve(),
    reportError: () => undefined,
    onWorkspaceClosed,
  })
  return { subject, onWorkspaceClosed }
}

it('reports a closed workspace once main confirmed the close', async () => {
  const { subject, onWorkspaceClosed } = actions(() =>
    Promise.resolve({ ok: true, value: state }),
  )
  await subject.closeWorkspace('p', 'w', plan, false)
  expect(onWorkspaceClosed).toHaveBeenCalledWith('p', 'w')
})

it('reports nothing when main refused the close', async () => {
  const { subject, onWorkspaceClosed } = actions(() =>
    Promise.resolve({ ok: false, error: 'refused' }),
  )
  await expect(subject.closeWorkspace('p', 'w', plan, false)).rejects.toThrow('refused')
  expect(onWorkspaceClosed).not.toHaveBeenCalled()
})

it('reports the close only after the transition has returned its state', async () => {
  vi.stubGlobal('window', {
    hvir: { invoke: () => Promise.resolve({ ok: true, value: state }) },
  })
  const order: string[] = []
  const subject = createWorkspaceSessionActions({
    runTransition: async (operation) => {
      const next = await operation()
      order.push('transition')
      return next
    },
    ensureProjectConnected: () => Promise.resolve(),
    reportError: () => undefined,
    onWorkspaceClosed: () => order.push('closed'),
  })
  await subject.closeWorkspace('p', 'w', plan, false)
  expect(order).toEqual(['transition', 'closed'])
})

it('reports nothing when the transition was superseded', async () => {
  vi.stubGlobal('window', {
    hvir: { invoke: () => Promise.resolve({ ok: true, value: state }) },
  })
  const onWorkspaceClosed = vi.fn()
  const subject = createWorkspaceSessionActions({
    runTransition: async (operation) => {
      await operation()
      return undefined
    },
    ensureProjectConnected: () => Promise.resolve(),
    reportError: () => undefined,
    onWorkspaceClosed,
  })
  await subject.closeWorkspace('p', 'w', plan, false)
  expect(onWorkspaceClosed).not.toHaveBeenCalled()
})
