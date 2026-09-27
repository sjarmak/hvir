// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type {
  ArchitectureCommit,
  ArchitectureCommitClassifyResult,
  ArchitectureCommitRange,
} from '../src/shared/architecture-review'
import { ArchitectureCommitStrip } from '../src/renderer/src/architecture-review/ArchitectureCommitStrip'

const revision = (n: number) => n.toString(16).padStart(40, '0')
const commit = (n: number, merge: boolean): ArchitectureCommit => ({
  revision: revision(n),
  parent: revision(0),
  merge,
  subject: `commit ${n}`,
  authoredAt: '2026-09-26T10:00:00+00:00',
})
const range: ArchitectureCommitRange = {
  base: commit(0, false),
  commits: [commit(3, true), commit(2, true), commit(1, false)],
  truncated: false,
}
const classified: ArchitectureCommitClassifyResult = {
  head: revision(3),
  classifications: [
    {
      revision: revision(3),
      parent: revision(0),
      merge: true,
      change: 'architecture',
      fleet: { type: 'Feature', architectural: 'architectural', beads: [] },
    },
    { revision: revision(2), parent: revision(0), merge: true, change: 'code' },
    {
      revision: revision(1),
      parent: revision(0),
      merge: false,
      change: 'none',
      fleet: { type: 'Documentation', beads: [] },
    },
  ],
}
const invoke = vi.fn((channel: string) => {
  if (channel === 'architecture-review:commits') return Promise.resolve(range)
  if (channel === 'architecture-review:classify-commits')
    return Promise.resolve(classified)
  return Promise.reject(new Error(`Unexpected channel ${channel}`))
})
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))
let host: HTMLDivElement
let app: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('hvir', { invoke, on: () => () => undefined })
  host = document.createElement('div')
  document.body.append(host)
  app = createRoot(host)
})
afterEach(() => {
  act(() => app.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('labels a fleet-classified merge on the strip by its change type and a bare merge as Merge', async () => {
  const root = localPath(`/repo-${Math.random().toString(16).slice(2)}`)
  act(() =>
    app.render(
      <ArchitectureCommitStrip
        root={root}
        ends={{}}
        disabled={false}
        onLock={vi.fn()}
        onChoose={vi.fn()}
      />,
    ),
  )
  await settle()
  await settle()
  const markers = Array.from(host.querySelectorAll('.architecture-strip-change'))
  expect(markers.map((marker) => marker.textContent)).toEqual([
    'Feature',
    'Merge',
    'Documentation',
  ])
  expect(markers.map((marker) => marker.className)).toEqual([
    'architecture-strip-change merge',
    'architecture-strip-change merge',
    'architecture-strip-change none',
  ])
  expect(markers[0]?.getAttribute('title')).toBe('Feature · Architectural')
  expect(markers[1]?.hasAttribute('title')).toBe(false)
})
