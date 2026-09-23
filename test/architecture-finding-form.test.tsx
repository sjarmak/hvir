// @vitest-environment happy-dom
import { act } from 'react'
import type { ArchitectureEvidence } from '../src/shared/architecture-review'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchitectureFindingForm } from '../src/renderer/src/architecture-review/ArchitectureFindingForm'

const root = { hostId: 'local', path: '/repo' } as never
const snapshot = {
  id: 'snap',
  fingerprint: 'fp',
  baselineRevision: 'base',
  currentRevision: 'head',
} as never
const evidence = {
  snapshotId: 'snap',
  stale: false,
  diff: {
    path: { hostId: 'local', path: '/repo/src/a.ts' },
    base: 'working-tree',
    baseLabel: 'base',
    currentLabel: 'head',
    baseInput: { content: 'old line', byteLength: 8 },
    currentInput: { content: 'new line', byteLength: 8 },
  },
} as ArchitectureEvidence

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(currentEvidence = evidence): { host: HTMLDivElement; rootNode: Root } {
  const host = document.createElement('div')
  document.body.append(host)
  const rootNode = createRoot(host)
  act(() =>
    rootNode.render(
      <ArchitectureFindingForm
        root={root}
        snapshot={snapshot}
        path="src/a.ts"
        evidence={currentEvidence}
      />,
    ),
  )
  return { host, rootNode }
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    'value',
  )?.set
  if (setter) Reflect.apply(setter, element, [value])
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function fillValid(host: HTMLDivElement, line = '1'): Promise<void> {
  const inputs = host.querySelectorAll('input')
  await act(async () => {
    setValue(inputs[0] as HTMLInputElement, 'Title')
    setValue(host.querySelector('textarea') as HTMLTextAreaElement, 'Body')
    setValue(inputs[1] as HTMLInputElement, line)
    await Promise.resolve()
  })
}

function submit(host: HTMLDivElement): void {
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

async function unmount(rootNode: Root): Promise<void> {
  await act(async () => {
    rootNode.unmount()
    await Promise.resolve()
  })
}

function listenForCommands(resolve: (handler: (accepted: boolean) => void) => void) {
  const commands: string[] = []
  const listener = (event: Event) => {
    const detail = (
      event as CustomEvent<{ command: string; resolve: (value: boolean) => void }>
    ).detail
    commands.push(detail.command)
    resolve(detail.resolve)
  }
  window.addEventListener('hvir:bead-command', listener)
  return {
    commands,
    dispose: () => window.removeEventListener('hvir:bead-command', listener),
  }
}

describe('ArchitectureFindingForm', () => {
  it('does not create before submit and emits exact provenance JSON', async () => {
    const received = listenForCommands((resolve) => resolve(true))
    const { host, rootNode } = mount()
    await fillValid(host)
    expect(received.commands).toHaveLength(0)
    await act(async () => {
      submit(host)
      await Promise.resolve()
    })
    expect(received.commands).toHaveLength(1)
    const match = received.commands[0]?.match(/--description '([^']+)'/)
    expect(match).not.toBeNull()
    expect(JSON.parse(match?.[1] ?? '')).toEqual({
      body: 'Body',
      citation: {
        root,
        path: 'src/a.ts',
        side: 'after',
        line: 1,
        snapshotId: 'snap',
        fingerprint: 'fp',
        baselineRevision: 'base',
        currentRevision: 'head',
      },
    })
    await unmount(rootNode)
    received.dispose()
  })

  it.each(['0', '2'])('rejects invalid after-side line %s', async (line) => {
    const received = listenForCommands((resolve) => resolve(true))
    const { host, rootNode } = mount()
    await fillValid(host, line)
    submit(host)
    expect(received.commands).toHaveLength(0)
    await unmount(rootNode)
    received.dispose()
  })

  it('rejects an invalid before-side line range', async () => {
    const received = listenForCommands((resolve) => resolve(true))
    const { host, rootNode } = mount()
    await fillValid(host, '2')
    const side = host.querySelector('select') as HTMLSelectElement
    await act(async () => {
      side.value = 'before'
      side.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    submit(host)
    expect(received.commands).toHaveLength(0)
    await unmount(rootNode)
    received.dispose()
  })

  it('blocks stale evidence and reports dispatch refusal', async () => {
    const stale = listenForCommands((resolve) => resolve(false))
    const mounted = mount({ ...evidence, stale: true })
    await fillValid(mounted.host)
    submit(mounted.host)
    expect(stale.commands).toHaveLength(0)
    await unmount(mounted.rootNode)
    stale.dispose()

    const refused = listenForCommands((resolve) => resolve(false))
    const current = mount()
    await fillValid(current.host)
    await act(async () => {
      submit(current.host)
      await Promise.resolve()
    })
    expect(refused.commands).toHaveLength(1)
    expect(current.host.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be created',
    )
    await unmount(current.rootNode)
    refused.dispose()
  })

  it('accepts only one command for rapid duplicate submits', async () => {
    const received = listenForCommands((resolve) => resolve(true))
    const { host, rootNode } = mount()
    await fillValid(host)
    await act(async () => {
      submit(host)
      submit(host)
      await Promise.resolve()
    })
    expect(received.commands).toHaveLength(1)
    await unmount(rootNode)
    received.dispose()
  })
})
