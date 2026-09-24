// @vitest-environment happy-dom
/* Async act flushes React effects and IPC promise continuations. */
/* eslint-disable @typescript-eslint/require-await */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ArchitectureEvidence } from '../src/shared/architecture-review'
import { analyzeArchitecture } from '../src/main/architecture-review/analysis'
import { ArchitectureReview } from '../src/renderer/src/architecture-review/ArchitectureReview'
import {
  ARCHITECTURE_REVIEW_LAUNCH_EVENT,
  type ArchitectureReviewLaunchDetail,
} from '../src/renderer/src/architecture-review/architecture-review-launch'

vi.mock('../src/renderer/src/viewer/DiffView', () => ({
  DiffView: () => <div data-testid="captured-diff" />,
}))
const root = localPath('/repo')
const analysis = analyzeArchitecture(
  { scope: '.', exclusions: [], files: [] },
  {
    scope: '.',
    exclusions: [],
    files: [{ path: 'src/a.ts', content: 'export const a = 1' }],
  },
)
const snapshot = {
  id: 's',
  root,
  baselineRef: 'branch point',
  currentRef: 'working tree',
  analysis,
  baselineRevision: 'b',
  currentRevision: 'a',
  fingerprint: 'fingerprint',
  exclusions: [],
  capturedAt: '2026-09-23',
  metrics: {
    totalMs: 42.5,
    timingFaults: [
      'Worker stages not shown: Architecture worker returned malformed timings',
    ],
    spans: [
      { stage: 'listing', startMs: 0, durationMs: 2, bytes: 900, items: 3, hostCalls: 2 },
      {
        stage: 'live-read',
        side: 'current',
        startMs: 2,
        durationMs: 30.25,
        bytes: 2_500_000,
        items: 10,
        hostCalls: 30,
      },
    ],
  },
}
const prepared = {
  root,
  reviewId: 'r',
  snapshotId: 's',
  path: localPath('/repo/src/a.ts'),
  digest: 'd',
  body: 'exact captured prompt',
}
const revision = (digit: string) => digit.repeat(40)
const commits = {
  base: { revision: revision('0'), parent: null, subject: 'base' },
  commits: ['1', '2', '3'].map((digit, index) => ({
    revision: revision(digit),
    parent: revision(String(index)),
    subject: `commit ${digit}`,
  })),
  truncated: false,
}
type ScanRequest = { baseline?: string; current?: string }
let host: HTMLDivElement
let app: ReturnType<typeof createRoot>
let stale: boolean
const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stale = false
  invoke.mockImplementation(async (channel: string, request?: ScanRequest) => {
    if (channel === 'architecture-review:scan')
      return {
        ...snapshot,
        baselineRef: request?.baseline ?? 'branch point',
        currentRef: request?.current ?? 'working tree',
        currentRevision: request?.current ?? 'working-tree',
      }
    if (channel === 'architecture-review:commits') return commits
    if (channel === 'harness:catalog')
      return [{ id: 'codex', architectureReviewLaunch: true }]
    if (channel === 'harness:profiles')
      return [
        {
          id: 'p',
          displayName: 'Native',
          providerId: 'codex',
          launchRevision: 2,
          executable: { kind: 'provider-default' },
          args: [],
        },
      ]
    if (channel === 'architecture-review:evidence')
      return {
        snapshotId: 's',
        stale,
        diff: {
          path: prepared.path,
          base: 'working-tree',
          baseLabel: 'before',
          currentLabel: 'after',
          baseInput: { kind: 'text', content: '', byteLength: 0 },
          currentInput: { kind: 'text', content: 'export const a = 1', byteLength: 18 },
        },
      }
    if (channel === 'architecture-review:prepare') return prepared
    return undefined
  })
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
async function openEvidence() {
  await act(async () => app.render(<ArchitectureReview root={root} active />))
  await click(button('Scan snapshot'))
  await click(host.querySelector<HTMLElement>('.architecture-module')!)
}
it('requires explicit preparation and launches one exact prompt through the native owner', async () => {
  const launched = vi.fn((event: Event) =>
    (event as CustomEvent<ArchitectureReviewLaunchDetail>).detail.resolve(true),
  )
  window.addEventListener(ARCHITECTURE_REVIEW_LAUNCH_EVENT, launched)
  try {
    await openEvidence()
    expect(host.querySelector('[data-testid="captured-diff"]')).not.toBeNull()
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'architecture-review:prepare'),
    ).toBe(false)
    expect(launched).not.toHaveBeenCalled()
    await click(button('Prepare exact prompt'))
    expect(host.querySelector('pre')?.textContent).toBe(prepared.body)
    expect(button('Launch review agent').disabled).toBe(true)
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>(
        '.architecture-review-launch select',
      )!
      select.value = 'p'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(button('Launch review agent'))
    expect(launched).toHaveBeenCalledOnce()
    const detail = (
      launched.mock.calls[0]![0] as CustomEvent<ArchitectureReviewLaunchDetail>
    ).detail
    expect(detail).toMatchObject({
      profileId: 'p',
      launchRevision: 2,
      launch: { digest: 'd', snapshotId: 's', path: prepared.path },
    })
    expect(button('Review session requested').disabled).toBe(true)
  } finally {
    window.removeEventListener(ARCHITECTURE_REVIEW_LAUNCH_EVENT, launched)
  }
})
it('shows stale captured evidence but prevents prompt preparation and finding submission', async () => {
  stale = true
  await openEvidence()
  expect(host.textContent).toContain('This capture is stale')
  expect(button('Prepare exact prompt').disabled).toBe(true)
  expect(button('Create bead from finding').disabled).toBe(true)
})
it('drops a pending preparation result after a fresh snapshot replaces its evidence', async () => {
  await openEvidence()
  let resolve!: (value: typeof prepared) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  await click(button('Prepare exact prompt'))
  await click(button('Scan snapshot'))
  await act(async () => resolve(prepared))
  expect(host.querySelector('pre')).toBeNull()
  expect(button('Launch review agent')).toBeUndefined()
})

it('shows the captured diff while freshness is pending and keeps actions blocked', async () => {
  const original: (channel: string) => Promise<unknown> = invoke.getMockImplementation()!
  let resolve!: (value: unknown) => void
  invoke.mockImplementation(
    async (channel: string, request: { capturedOnly?: boolean }) => {
      if (channel !== 'architecture-review:evidence') return original(channel)
      const evidence = (await original(channel)) as ArchitectureEvidence
      if (request.capturedOnly) return { ...evidence, stale: null }
      return new Promise((done) => {
        resolve = done
      })
    },
  )
  await openEvidence()
  expect(host.querySelector('[data-testid="captured-diff"]')).not.toBeNull()
  expect(host.textContent).toContain('Checking snapshot freshness')
  expect(button('Prepare exact prompt').disabled).toBe(true)
  expect(button('Create bead from finding').disabled).toBe(true)
  await act(async () => resolve(await original('architecture-review:evidence')))
  expect(host.textContent).not.toContain('Checking snapshot freshness')
  expect(button('Prepare exact prompt').disabled).toBe(false)
})

it('retains readable pinned evidence after validation fails, without allowing actions', async () => {
  const original: (channel: string) => Promise<unknown> = invoke.getMockImplementation()!
  invoke.mockImplementation(
    async (channel: string, request: { capturedOnly?: boolean }) => {
      if (channel !== 'architecture-review:evidence') return original(channel)
      if (!request.capturedOnly) throw new Error('SSH disconnected')
      return { ...((await original(channel)) as ArchitectureEvidence), stale: null }
    },
  )
  await openEvidence()
  expect(host.querySelector('[data-testid="captured-diff"]')).not.toBeNull()
  expect(host.textContent).toContain('SSH disconnected')
  expect(host.textContent).toContain('Snapshot freshness could not be checked')
  expect(host.textContent).not.toContain('Checking snapshot freshness')
  expect(button('Prepare exact prompt').disabled).toBe(true)
  expect(button('Create bead from finding').disabled).toBe(true)
})
it('ignores late freshness completion after a replacement scan', async () => {
  const original: (channel: string) => Promise<unknown> = invoke.getMockImplementation()!
  let resolve!: (value: unknown) => void
  invoke.mockImplementation(
    async (channel: string, request: { capturedOnly?: boolean }) => {
      if (channel !== 'architecture-review:evidence') return original(channel)
      if (request.capturedOnly)
        return { ...((await original(channel)) as ArchitectureEvidence), stale: null }
      return new Promise((done) => {
        resolve = done
      })
    },
  )
  await openEvidence()
  await click(button('Scan snapshot'))
  await act(async () => resolve(await original('architecture-review:evidence')))
  expect(host.querySelector('[data-testid="captured-diff"]')).toBeNull()
})

it('shows per-stage scan cost in the snapshot details', async () => {
  await act(async () => app.render(<ArchitectureReview root={root} active />))
  await click(button('Scan snapshot'))
  const table = host.querySelector('table[aria-label="Scan timings"]')!
  expect(table.querySelector('caption')?.textContent).toContain('42.5 ms')
  const rows = Array.from(table.querySelectorAll('tbody tr')).map((row) =>
    Array.from(row.children).map((cell) => cell.textContent),
  )
  expect(rows).toEqual([
    ['listing', '2.0 ms', '900 B', '3', '2'],
    ['live-read', '30.3 ms', '2.4 MB', '10', '30'],
  ])
  const faults = host.querySelector('[aria-label="Scan timing faults"]')
  expect(faults?.textContent).toBe(
    'Worker stages not shown: Architecture worker returned malformed timings',
  )
})

const scans = () =>
  invoke.mock.calls
    .filter(([channel]) => channel === 'architecture-review:scan')
    .map(([, request]) => {
      const { baseline, current } = request as ScanRequest
      return { baseline, current }
    })
const commitButton = (digit: string) =>
  host.querySelector<HTMLButtonElement>(`button[title="${revision(digit)}"]`)!
async function type(label: string, value: string) {
  const input = Array.from(host.querySelectorAll('label'))
    .find((node) => node.textContent?.startsWith(label))!
    .querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      value,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('scans the typed ends and treats a blank end as its default', async () => {
  await act(async () => app.render(<ArchitectureReview root={root} active />))
  await click(button('Scan snapshot'))
  await type('Baseline', ' v1 ')
  await click(button('Scan snapshot'))
  await type('Current', 'HEAD~1')
  await click(button('Scan snapshot'))
  expect(scans()).toEqual([
    { baseline: undefined, current: undefined },
    { baseline: 'v1', current: undefined },
    { baseline: 'v1', current: 'HEAD~1' },
  ])
  expect(host.querySelector('summary')?.textContent).toContain('v1 → HEAD~1')
})

it('refuses an option-shaped ref before any scan is sent', async () => {
  await act(async () => app.render(<ArchitectureReview root={root} active />))
  await type('Baseline', '--all')
  expect(host.textContent).toContain('A ref cannot start with "-"')
  expect(button('Scan snapshot').disabled).toBe(true)
  expect(scans()).toEqual([])
})

it('steps the strip pairwise, then against a locked baseline', async () => {
  await act(async () => app.render(<ArchitectureReview root={root} active />))
  expect(invoke).toHaveBeenCalledWith('architecture-review:commits', { root })
  await click(commitButton('2'))
  expect(commitButton('2').getAttribute('aria-pressed')).toBe('true')
  await click(button('Next commit'))
  await click(commitButton('1'))
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  )
  expect(host.textContent).toContain(`Baseline held at ${revision('0').slice(0, 8)}`)
  await click(button('Next commit'))
  await click(button('Next commit'))
  expect(button('Next commit').disabled).toBe(true)
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  )
  await click(button('Previous commit'))
  expect(scans()).toEqual([
    { baseline: revision('1'), current: revision('2') },
    { baseline: revision('2'), current: revision('3') },
    { baseline: revision('0'), current: revision('1') },
    { baseline: revision('0'), current: revision('2') },
    { baseline: revision('0'), current: revision('3') },
    { baseline: revision('1'), current: revision('2') },
  ])
})

it('widens the strip from any ref', async () => {
  await act(async () => app.render(<ArchitectureReview root={root} active />))
  await type('Widen from', 'main~3')
  await click(button('List commits'))
  expect(invoke).toHaveBeenLastCalledWith('architecture-review:commits', {
    root,
    from: 'main~3',
  })
})
