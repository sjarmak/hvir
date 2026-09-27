// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath, type GitCommitSummary } from '../src/shared'
import type { ArchitectureCommitChange } from '../src/shared/architecture-review'
import { GitHistoryView } from '../src/renderer/src/git/GitHistoryView'
import type { CommitClassificationState } from '../src/renderer/src/architecture-review/use-commit-classifications'

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
const known = new Map<string, ArchitectureCommitChange>([
  [hash(3), 'architecture'],
  [hash(2), 'code'],
  [hash(1), 'architecture'],
])
const classifications: CommitClassificationState = {
  known,
  pending: new Set(),
  generation: 0,
}
let host: HTMLDivElement
let app: ReturnType<typeof createRoot>
const onShowInArchitecture = vi.fn()
const onShowRangeInArchitecture = vi.fn()
const onArchitectureOnly = vi.fn()
const onVisibleCommits = vi.fn()

function render(architectureOnly: boolean, state = classifications): void {
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
        classifications={state}
        architectureOnly={architectureOnly}
        onArchitectureOnly={onArchitectureOnly}
        onShowInArchitecture={onShowInArchitecture}
        onShowRangeInArchitecture={onShowRangeInArchitecture}
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

it('marks each row with its architecture change, its date and a secondary hash', () => {
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

it('opens the Architecture tab for any commit with a parent, merges included', () => {
  render(false)
  const show = (n: number) =>
    host.querySelector<HTMLButtonElement>(
      `button[aria-label="Show ${hash(n).slice(0, 7)} in architecture"]`,
    )
  act(() => show(3)!.click())
  expect(onShowInArchitecture).toHaveBeenCalledWith(commits[1])
  act(() => show(4)!.click())
  expect(onShowInArchitecture).toHaveBeenLastCalledWith(commits[0])
  expect(show(1)).toBeNull()
})

it('filters to architecture changes and hides merges, remembering the choice', () => {
  render(false)
  const toggle = host.querySelector<HTMLInputElement>(
    'input[type="checkbox"][aria-label="Architecture changes only"]',
  )!
  expect(toggle.checked).toBe(false)
  expect(toggle.closest('label')?.textContent?.trim()).toBe('Architecture only')
  act(() => toggle.click())
  expect(onArchitectureOnly).toHaveBeenCalledWith(true)
  render(true)
  expect(rowText()).toEqual(['Rewire modules', 'Add modules'])
  expect(onVisibleCommits).toHaveBeenLastCalledWith(commits.map((c) => c.hash))
})

it('hides rows still classifying under the filter and says so, keeping unclassified rows', () => {
  render(true, {
    known: new Map([[hash(1), 'unclassified']]),
    pending: new Set([hash(3), hash(2)]),
    generation: 0,
  })
  expect(rowText()).toEqual(['Add modules'])
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    'Classifying 2 commits…',
  )
  expect(host.querySelector('.git-rail-commit-change')?.textContent).toBe('Unclassified')
  expect(host.querySelector('.git-empty')).toBeNull()
  render(true, { known: new Map(), pending: new Set(), generation: 1, error: 'boom' })
  expect(host.querySelector('.tree-error')?.textContent).toContain('boom')
})

const commitButton = (n: number) =>
  rows()
    .find((row) => row.textContent?.includes(hash(n).slice(0, 7)))!
    .querySelector<HTMLButtonElement>('.git-rail-commit')!
const clickRow = (n: number, shiftKey = false): void =>
  act(() => {
    commitButton(n).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }),
    )
  })
const rangeBar = () => host.querySelector('.git-history-range')
const showRange = () => host.querySelector<HTMLButtonElement>('.git-history-range-show')!
const selectedRows = () =>
  rows()
    .filter((row) => row.classList.contains('selected'))
    .map((row) => row.querySelector('strong > span')?.textContent)

it('shift-clicks a range and opens it in architecture, oldest commit first', () => {
  render(false)
  expect(rangeBar()).toBeNull()
  clickRow(2)
  expect(rangeBar()).toBeNull()
  clickRow(4, true)
  expect(rangeBar()?.textContent).toContain('3 commits selected')
  expect(selectedRows()).toEqual(['Merge side', 'Rewire modules', 'Fix a body'])
  act(() => showRange().click())
  expect(onShowRangeInArchitecture).toHaveBeenCalledWith({
    olderCommit: commits[2],
    newerCommit: commits[0],
    hashes: [hash(4), hash(3), hash(2)],
  })
  act(() => host.querySelector<HTMLButtonElement>('.git-history-range-clear')!.click())
  expect(rangeBar()).toBeNull()
  expect(selectedRows()).toEqual([])
})

it('orders a reversed shift-click the same way and restarts on a plain click', () => {
  render(false)
  clickRow(4)
  clickRow(2, true)
  act(() => showRange().click())
  expect(onShowRangeInArchitecture).toHaveBeenLastCalledWith({
    olderCommit: commits[2],
    newerCommit: commits[0],
    hashes: [hash(4), hash(3), hash(2)],
  })
  clickRow(3)
  expect(rangeBar()).toBeNull()
  clickRow(4, true)
  expect(selectedRows()).toEqual(['Merge side', 'Rewire modules'])
})

it('refuses a range whose oldest commit has no parent and says why', () => {
  render(false)
  clickRow(1)
  clickRow(3, true)
  expect(rangeBar()?.textContent).toContain(`${hash(1).slice(0, 7)} has no parent`)
  expect(showRange().disabled).toBe(true)
  act(() => showRange().click())
  expect(onShowRangeInArchitecture).not.toHaveBeenCalled()
})

it('starts a fresh range after the filter hides the anchor instead of going inert', () => {
  render(false)
  clickRow(2)
  render(true)
  expect(rowText()).toEqual(['Rewire modules', 'Add modules'])
  expect(rangeBar()).toBeNull()
  clickRow(3, true)
  clickRow(1, true)
  expect(rangeBar()?.textContent).toContain('2 commits selected')
  expect(selectedRows()).toEqual(['Rewire modules', 'Add modules'])
  render(false)
  clickRow(4, true)
  expect(selectedRows()).toEqual(['Merge side', 'Rewire modules'])
})
