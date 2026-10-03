// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReviewCheckpointPanel } from '../src/renderer/src/git/ReviewCheckpointPanel'
import { hostPath, type HostPath } from '../src/shared'

vi.mock('../src/renderer/src/viewer/DiffView', () => ({
  DiffView: ({ capturedInputs }: { readonly capturedInputs?: { readonly baseLabel: string } }) =>
    <div data-testid="checkpoint-diff">{capturedInputs?.baseLabel}</div>,
}))

const rootPath = hostPath('local' as HostPath['hostId'], '/repo')
const filePath = hostPath('local' as HostPath['hostId'], '/repo/src/main.ts')

let container: HTMLDivElement
let reactRoot: Root
let invoke: ReturnType<typeof vi.fn>
let send: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('crypto', { randomUUID: () => 'review-operation' })
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
  invoke = vi.fn((channel: string) => {
    if (channel === 'git:review-checkpoint') return Promise.resolve(status(null, []))
    return Promise.resolve(undefined)
  })
  send = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke, send },
  })
})

afterEach(() => {
  act(() => reactRoot.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ReviewCheckpointPanel', () => {
  it('loads an empty checkpoint and exposes explicit save and refresh controls', async () => {
    await render()
    expect(invoke).toHaveBeenCalledWith('git:review-checkpoint', expect.objectContaining({
      id: 'review-operation',
      root: rootPath,
      action: 'status',
    }))
    expect(container.textContent).toContain('No review checkpoint saved.')
    expect(button('Save checkpoint').disabled).toBe(false)
    expect(button('Clear').disabled).toBe(true)
  })

  it('advances a saved checkpoint, refreshes status, and opens the exact selected diff', async () => {
    const checkpoint = status('a'.repeat(40), [
      { path: filePath, before: null, after: { mode: '100644', oid: 'b'.repeat(40) } },
    ])
    invoke.mockImplementation(((channel: string, payload: { readonly action?: string }): Promise<unknown> => {
      if (channel !== 'git:review-checkpoint') return Promise.resolve(undefined)
      if (payload.action === 'status') return Promise.resolve(checkpoint)
      if (payload.action === 'diff')
        return Promise.resolve({
          path: filePath,
          checkpoint: 'a'.repeat(40),
          baseInput: text('before'),
          currentInput: text('after'),
        })
      return Promise.resolve(undefined)
    }) as never)
    await render()
    expect(container.textContent).toContain('Advance checkpoint')
    await click('Advance checkpoint')
    expect(invoke).toHaveBeenCalledWith('git:review-checkpoint', expect.objectContaining({
      root: rootPath,
      action: 'capture',
    }))
    await click('src/main.ts')
    expect(container.querySelector('[data-testid="checkpoint-diff"]')?.textContent).toBe('Checkpoint')
  })

  it('cancels and ignores a late result when the panel becomes hidden', async () => {
    let resolve!: (value: unknown) => void
    invoke.mockImplementation(((channel: string): Promise<unknown> =>
      channel === 'git:review-checkpoint' ? new Promise((next) => { resolve = next }) : Promise.resolve(undefined)
    ) as never)
    await render()
    await render(false)
    expect(send).toHaveBeenCalledWith('git:review-checkpoint-cancel', { id: 'review-operation' })
    await act(async () => {
      resolve(status('a'.repeat(40), []))
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('Advance checkpoint')
  })

  it('surfaces binary and stale-input failures from the capability', async () => {
    let refresh = false
    invoke.mockImplementation(((channel: string, payload: { readonly action?: string }): Promise<unknown> => {
      if (channel === 'git:review-checkpoint' && payload.action === 'status') {
        if (!refresh) {
          refresh = true
          return Promise.resolve(status('a'.repeat(40), []))
        }
        return Promise.reject(new Error('File changed since comparison; refresh changes since review'))
      }
      return Promise.resolve(undefined)
    }) as never)
    await render()
    await click('Refresh')
    expect(container.textContent).toContain('File changed since comparison; refresh changes since review')
  })

  it('clears the prior root while the new root checkpoint is pending', async () => {
    let operationNumber = 0
    vi.stubGlobal('crypto', {
      randomUUID: () => operationNumber++ === 0 ? 'old-operation' : 'new-operation',
    })
    let resolveOld!: (value: unknown) => void
    let resolveNew!: (value: unknown) => void
    let statusCalls = 0
    invoke.mockImplementation(((channel: string, payload: { readonly action?: string }): Promise<unknown> => {
      if (channel !== 'git:review-checkpoint' || payload.action !== 'status')
        return Promise.resolve(undefined)
      statusCalls += 1
      return new Promise((resolve) => {
        if (statusCalls === 1) resolveOld = resolve
        else resolveNew = resolve
      })
    }) as never)
    await render()
    const otherRoot = hostPath('local' as HostPath['hostId'], '/other')
    await renderAt(otherRoot)
    expect(container.textContent).not.toContain('aaaaaaaa')
    await act(async () => {
      resolveOld(status('a'.repeat(40), []))
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('aaaaaaaa')
    await act(async () => {
      resolveNew(status('b'.repeat(40), [], otherRoot))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('b'.repeat(40))
    expect(send).toHaveBeenCalledWith('git:review-checkpoint-cancel', { id: 'old-operation' })
  })
})

function status(oid: string | null, changes: readonly unknown[], root = rootPath) {
  return { root, oid, changes }
}

function text(content: string) {
  return { content, byteLength: content.length, lineCount: 1, complete: true }
}

async function render(visible = true): Promise<void> {
  await renderAt(rootPath, visible)
}

async function renderAt(root: HostPath, visible = true): Promise<void> {
  await act(async () => {
    reactRoot.render(
      <ReviewCheckpointPanel root={root} connectionState="connected" visible={visible} />,
    )
    await Promise.resolve()
  })
}

async function click(label: string): Promise<void> {
  const element = button(label)
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  )
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`)
  return found
}
