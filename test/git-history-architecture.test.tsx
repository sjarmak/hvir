// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath, type GitCommitSummary } from '../src/shared'
import type { ArchitectureCommitChange } from '../src/shared/architecture-review'
import { GitHistoryView } from '../src/renderer/src/git/GitHistoryView'

const root = localPath('/repo')
const hash = (n: number) => n.toString(16).repeat(40)
const commit = (
  n: number,
  parents: readonly string[],
  subject: string,
): GitCommitSummary => ({
  hash: hash(n),
  shortHash: hash(n).slice(0, 7),
  parents,
  refs: [],
  author: 'Ada',
  authoredAt: `2026-09-2${n}T10:00:00+00:00`,
  subject,
})
const commits = [
  commit(4, [hash(3), hash(2)], 'Merge side'),
  commit(3, [hash(1)], 'Rewire modules'),
  commit(2, [hash(1)], 'Fix a body'),
  commit(1, [], 'Add modules'),
]
const classifications = new Map<string, ArchitectureCommitChange>([
  [hash(3), 'architecture'],
  [hash(2), 'code'],
  [hash(1), 'architecture'],
])
let host: HTMLDivElement
let app: ReturnType<typeof createRoot>
const onShowInArchitecture = vi.fn()
const onArchitectureOnly = vi.fn()
const onVisibleCommits = vi.fn()

function render(architectureOnly: boolean): void {
  return act(() =>
    app.render(
      <GitHistoryView
        commits={commits}
        hasMore={false}
        initialLoading={false}
        repositoryState="ready"
        root={root}
        expanded={new Set()}
        detailStates={new Map()}
        collapsedDirectories={new Map()}
        classifications={classifications}
        architectureOnly={architectureOnly}
        onArchitectureOnly={onArchitectureOnly}
        onShowInArchitecture={onShowInArchitecture}
        onVisibleCommits={onVisibleCommits}
        onOpenGraph={vi.fn()}
        onOpenFile={vi.fn()}
        onLoadMore={vi.fn()}
        onToggleCommit={vi.fn()}
        onToggleDirectory={vi.fn()}
      />,
    ),
  )
}
const rows = () => Array.from(host.querySelectorAll('.git-rail-history-row.commit'))
const rowText = () => rows().map((row) => row.querySelector('strong > span')?.textContent)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  app = createRoot(host)
})
afterEach(() => {
  act(() => app.unmount())
  host.remove()
  vi.clearAllMocks()
})

it('marks each row with its architecture change, its date and a secondary hash', async () => {
  render(false)
  expect(rowText()).toEqual(['Merge side', 'Rewire modules', 'Fix a body', 'Add modules'])
  const markers = rows().map(
    (row) => row.querySelector('.git-rail-commit-change')?.textContent ?? '',
  )
  expect(markers).toEqual(['Merge', 'Architecture', 'Code', 'Architecture'])
  const meta = rows()[1]!.querySelector('small')!.textContent
  expect(meta).toContain('2026-09-23')
  expect(meta).toContain('Ada')
  expect(meta).toContain(hash(3).slice(0, 7))
  expect(meta.indexOf('2026-09-23')).toBeLessThan(meta.indexOf(hash(3).slice(0, 7)))
  expect(onVisibleCommits).toHaveBeenLastCalledWith(commits.map((c) => c.hash))
})

it('opens the Architecture tab for a commit against its first parent', async () => {
  render(false)
  act(() =>
    host
      .querySelector<HTMLButtonElement>(
        `button[aria-label="Show ${hash(3).slice(0, 7)} in architecture"]`,
      )!
      .click(),
  )
  expect(onShowInArchitecture).toHaveBeenCalledWith(commits[1])
  expect(
    host.querySelector(
      `button[aria-label="Show ${hash(1).slice(0, 7)} in architecture"]`,
    ),
  ).toBeNull()
})

it('filters to architecture changes and hides merges, remembering the choice', async () => {
  render(false)
  const toggle = host.querySelector<HTMLInputElement>(
    'input[type="checkbox"][aria-label="Architecture changes only"]',
  )!
  expect(toggle.checked).toBe(false)
  act(() => toggle.click())
  expect(onArchitectureOnly).toHaveBeenCalledWith(true)
  render(true)
  expect(rowText()).toEqual(['Rewire modules', 'Add modules'])
  expect(onVisibleCommits).toHaveBeenLastCalledWith(commits.map((c) => c.hash))
})
