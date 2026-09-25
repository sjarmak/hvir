// @vitest-environment happy-dom
/* Async act flushes React effects and IPC promise continuations. */
/* eslint-disable @typescript-eslint/require-await */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ArchitectureScopeRefusal } from '../src/shared/architecture-scope'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'
import { ArchitectureReview } from '../src/renderer/src/architecture-review/ArchitectureReview'

vi.mock('../src/renderer/src/architecture-review/architecture-layout-client', () => ({
  requestArchitectureLayout: () => new Promise(() => undefined),
}))

const root = localPath('/repo')
const files = { scope: '.', exclusions: [], files: [] }
const snapshot = (scope: readonly string[]) => ({
  id: 's',
  root,
  baselineRef: 'branch point',
  currentRef: 'working tree',
  analysis: analyzeArchitecture(files, {
    ...files,
    files: [{ path: 'src/web/a.ts', content: 'export const a = 1' }],
  }),
  baselineRevision: 'b',
  currentRevision: 'working-tree',
  fingerprint: 'f',
  exclusions: [],
  layout: {
    origin: 'override',
    scope,
    sourceRoots: ['src'],
    systems: [],
    subsystems: [],
  },
  capturedAt: '2026-09-24',
  metrics: { totalMs: 1, timingFaults: [], spans: [] },
})
const refusal: ArchitectureScopeRefusal = {
  message:
    'Architecture scan refused: working tree has 5,210 files in the whole repository, above the cap of 4,000 files and 16 MiB. Choose a narrower scope and scan again; the review never reads part of a scope.',
  end: 'working tree',
  scope: [],
  files: 5_210,
  bytes: null,
  maxFiles: 4_000,
  maxBytes: 16 * 1024 * 1024,
  candidates: [
    { path: 'src', files: 4_000, bytes: null },
    { path: 'test', files: 1_210, bytes: null },
  ],
}

let host: HTMLDivElement
let app: ReturnType<typeof createRoot>
let saved: readonly string[] | undefined
const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  saved = undefined
  invoke.mockImplementation(
    async (channel: string, request?: { scope?: readonly string[] }) => {
      if (channel === 'architecture-review:scan')
        return saved ? snapshot(saved) : { refused: refusal }
      if (channel === 'architecture-review:scope') {
        saved = request!.scope
        return { scope: saved, written: true }
      }
      if (channel === 'architecture-review:commits')
        return {
          base: { revision: '0'.repeat(40), parent: null, subject: 'base' },
          commits: [],
          truncated: false,
        }
      return undefined
    },
  )
  vi.stubGlobal('hvir', { invoke })
  host = document.createElement('div')
  document.body.append(host)
  app = createRoot(host)
})
afterEach(() => {
  act(() => app.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
const button = (text: string) =>
  Array.from(host.querySelectorAll('button')).find((node) => node.textContent === text)!
const click = async (node: HTMLElement) => {
  await act(async () => node.click())
}

it('keeps the scope unsaveable until a scan reports the one in effect', async () => {
  await act(async () =>
    app.render(<ArchitectureReview root={root} active onHandoff={vi.fn()} />),
  )
  expect(host.textContent).toContain('Scope: shown after the first scan.')
  expect(button('Save scope and scan')).toBeUndefined()
})

it('shows a refusal with its counts and scans again once a narrower scope is saved', async () => {
  await act(async () =>
    app.render(<ArchitectureReview root={root} active onHandoff={vi.fn()} />),
  )
  await click(button('Scan snapshot'))
  const status = host.querySelector('[role="status"]')
  expect(status?.textContent).toBe(refusal.message)
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('.architecture-review-body')).toBeNull()
  const labels = Array.from(
    host.querySelectorAll('.architecture-review-scope-controls fieldset label'),
  ).map((node) => node.textContent)
  expect(labels).toEqual(['src · 4,000 files', 'test · 1,210 files'])
  await click(host.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!)
  expect(host.querySelector('textarea')?.value).toBe('src')
  await click(button('Save scope and scan'))
  expect(invoke).toHaveBeenCalledWith('architecture-review:scope', {
    root,
    scope: ['src'],
  })
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(host.querySelector('.architecture-review-body')).not.toBeNull()
  expect(
    host.querySelector('.architecture-review-scope-controls summary')?.textContent,
  ).toBe('Scope: src')
})

it('refuses to save a scope the layout file would reject', async () => {
  await act(async () =>
    app.render(<ArchitectureReview root={root} active onHandoff={vi.fn()} />),
  )
  await click(button('Scan snapshot'))
  const textarea = host.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      textarea,
      '../outside',
    )
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(host.textContent).toContain('"scope[0]" must be a relative path')
  expect(button('Save scope and scan').disabled).toBe(true)
})

it('shows why the scope could not be saved and does not scan', async () => {
  await act(async () =>
    app.render(<ArchitectureReview root={root} active onHandoff={vi.fn()} />),
  )
  await click(button('Scan snapshot'))
  invoke.mockImplementationOnce(async () => {
    throw new Error(
      'Invalid .hvir/architecture.json in the working tree: "version" must be 1',
    )
  })
  const scans = invoke.mock.calls.filter(
    ([channel]) => channel === 'architecture-review:scan',
  ).length
  await click(button('Save scope and scan'))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    '"version" must be 1',
  )
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'architecture-review:scan'),
  ).toHaveLength(scans)
})

it('drops a late scope-save failure once a newer scan has taken over', async () => {
  saved = ['src']
  await act(async () =>
    app.render(<ArchitectureReview root={root} active onHandoff={vi.fn()} />),
  )
  await click(button('Scan snapshot'))
  let fail: (cause: Error) => void = () => undefined
  invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)))
  await click(button('Save scope and scan'))
  const scans = invoke.mock.calls.filter(
    ([channel]) => channel === 'architecture-review:scan',
  ).length
  await click(button('Scan snapshot'))
  expect(host.querySelector('.architecture-review-body')).not.toBeNull()
  await act(async () => fail(new Error('disk write failed')))
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('.architecture-review-body')).not.toBeNull()
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'architecture-review:scan'),
  ).toHaveLength(scans + 1)
})

it('does not rescan over a newer scan when a superseded scope save lands', async () => {
  saved = ['src']
  await act(async () =>
    app.render(<ArchitectureReview root={root} active onHandoff={vi.fn()} />),
  )
  await click(button('Scan snapshot'))
  let land: (record: unknown) => void = () => undefined
  invoke.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
  await click(button('Save scope and scan'))
  await click(button('Scan snapshot'))
  const scans = invoke.mock.calls.filter(
    ([channel]) => channel === 'architecture-review:scan',
  ).length
  await act(async () => land({ scope: ['src'], written: true }))
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'architecture-review:scan'),
  ).toHaveLength(scans)
})
