// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PullsPanel } from '../src/renderer/src/github/PullsPanel'
import { asHostId, hostPath, type PullSummary, type PullsResponse } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/projects/widgets')

function pull(number: number, overrides: Partial<PullSummary> = {}): PullSummary {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: 'open',
    draft: false,
    headRef: `branch-${number}`,
    author: 'ben',
    updatedAt: '2026-09-30T00:00:00Z',
    checks: 'none',
    review: 'none',
    openFeedback: 0,
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root
let response: PullsResponse
let pullsCalls: number

beforeEach(() => {
  ;(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  pullsCalls = 0
  response = {
    available: true,
    repo: 'acme/widgets',
    viewer: 'stephanie',
    branch: 'feat/panel',
    branchPulls: [pull(1, { checks: 'failing', openFeedback: 2, author: 'stephanie' })],
    authored: [pull(1), pull(3, { draft: true })],
    reviewRequested: [pull(2, { review: 'review-required' })],
  }
  const invoke = vi.fn((channel: string) => {
    if (channel === 'github:pulls') {
      pullsCalls += 1
      return Promise.resolve(response)
    }
    return Promise.resolve(undefined)
  })
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.hvir = {
    invoke,
    on: () => () => undefined,
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  for (let hop = 0; hop < 4; hop += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function render(hidden = false): void {
  act(() => {
    root.render(createElement(PullsPanel, { root: ROOT, connected: true, hidden }))
  })
}

function sectionNumbers(label: string): readonly string[] {
  const section = [...host.querySelectorAll('.pulls-section')].find(
    (candidate) => candidate.querySelector('.pulls-section-label')?.textContent === label,
  )
  return [...(section?.querySelectorAll('[data-pull-number]') ?? [])].map(
    (row) => row.getAttribute('data-pull-number') ?? '',
  )
}

describe('PullsPanel', () => {
  it('lists each pull once under the section that matters most', async () => {
    render()
    await flush()
    expect(sectionNumbers('This branch')).toEqual(['1'])
    expect(sectionNumbers('Needs your review')).toEqual(['2'])
    expect(sectionNumbers('Yours')).toEqual(['3'])
    const branchRow = host.querySelector('[data-pull-number="1"]')
    expect(branchRow?.textContent).toContain('CI failing')
    expect(branchRow?.textContent).toContain('2 open comments')
    expect(branchRow?.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/1')
    expect(host.querySelector('[data-pull-number="2"]')?.textContent).toContain('@ben')
  })

  it('says why and what to do when gh is not signed in', async () => {
    response = {
      available: false,
      reason: 'gh-unauthenticated',
      message: 'run gh auth login',
    }
    render()
    await flush()
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(
      /Run gh auth login in a terminal/,
    )
  })

  it('notes a branch with no pull request', async () => {
    response = { ...response, available: true, branchPulls: [] } as PullsResponse
    render()
    await flush()
    expect(host.textContent).toContain('No pull request for feat/panel.')
  })

  it('does not query while hidden and polls while visible', async () => {
    render(true)
    await flush()
    expect(pullsCalls).toBe(0)
    render(false)
    await flush()
    expect(pullsCalls).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000)
    })
    expect(pullsCalls).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    await flush()
    expect(pullsCalls).toBe(2)
  })
})
