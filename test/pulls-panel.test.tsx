// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PullsPanel, type PullsPanelProps } from '../src/renderer/src/github/PullsPanel'
import {
  asHostId,
  hostPath,
  type PullDetailResponse,
  type PullSummary,
  type PullsResponse,
} from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/projects/widgets')

function pull(number: number, overrides: Partial<PullSummary> = {}): PullSummary {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: 'open',
    draft: false,
    headRef: `branch-${number}`,
    headRepo: 'acme/widgets',
    author: 'ben',
    updatedAt: '2026-09-30T00:00:00Z',
    checks: 'none',
    review: 'none',
    openFeedback: 0,
    headOid: `head-${number}`,
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root
let response: PullsResponse
let pullsCalls: number
let detailResponse: PullDetailResponse | Promise<PullDetailResponse>
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

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
  detailResponse = {
    available: true,
    repo: 'acme/widgets',
    number: 1,
    title: 'Change 1',
    url: 'https://github.com/acme/widgets/pull/1',
    headOid: 'head-1',
    threadsPageComplete: true,
    payloadTruncated: false,
    threads: [
      {
        id: 'thread-1',
        body: 'Please revisit this',
        author: 'reviewer',
        path: 'src/panel.ts',
        line: 8,
        isResolved: false,
        isOutdated: false,
        reviewedCommitOid: 'head-1',
        comments: [
          {
            id: 'comment-1',
            body: 'Please revisit this',
            author: 'reviewer',
            createdAt: '2026-10-02T00:00:00Z',
            commitOid: 'head-1',
          },
        ],
        commentsPageComplete: true,
      },
    ],
  }
  const invoke = vi.fn((channel: string) => {
    if (channel === 'github:pulls') {
      pullsCalls += 1
      return Promise.resolve(response)
    }
    if (channel === 'github:checkouts')
      return Promise.resolve({ available: true, checkouts: [] })
    if (channel === 'github:detail') return Promise.resolve(detailResponse)
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
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
})

async function flush(): Promise<void> {
  for (let hop = 0; hop < 4; hop += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function render(hidden = false, options: Partial<PullsPanelProps> = {}): void {
  act(() => {
    root.render(
      createElement(PullsPanel, { root: ROOT, connected: true, hidden, ...options }),
    )
  })
}

async function openFeedback(): Promise<void> {
  render()
  await flush()
  act(() => host.querySelector<HTMLButtonElement>('.pulls-detail-button')?.click())
  await flush()
  act(() => host.querySelector<HTMLInputElement>('.pulls-detail input')?.click())
}

function clickFeedbackButton(label: string): void {
  const button = [
    ...host.querySelectorAll<HTMLButtonElement>('.pulls-detail button'),
  ].find((candidate) => candidate.textContent === label)
  expect(button).toBeDefined()
  act(() => button?.click())
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
    expect(branchRow?.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/acme/widgets/pull/1',
    )
    expect(branchRow?.textContent).toContain('branch-1')
    expect(branchRow?.textContent).toContain('No checkout')
    expect(branchRow?.querySelector('a button')).toBeNull()
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

  it('explains how to authenticate gh when remote sessions cannot read credentials', async () => {
    response = {
      available: false,
      reason: 'gh-remote-unauthenticated',
      message: 'The token in default is invalid',
    }
    render()
    await flush()
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(
      /remote host.*gh auth login --insecure-storage/i,
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

  it('does not load details while the document is hidden', async () => {
    const invoke = (window.hvir as unknown as { invoke: ReturnType<typeof vi.fn> }).invoke
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    render()
    await flush()
    act(() => host.querySelector<HTMLButtonElement>('.pulls-detail-button')?.click())
    await flush()
    expect(invoke).not.toHaveBeenCalledWith('github:detail', expect.anything())
  })

  it('shows a detail read refusal without creating a preview', async () => {
    detailResponse = {
      available: false,
      reason: 'error',
      message: 'Pull request changed while loading details',
    }
    render()
    await flush()
    act(() => host.querySelector<HTMLButtonElement>('.pulls-detail-button')?.click())
    await flush()
    expect(host.textContent).toContain('Pull request changed while loading details')
    expect(host.querySelector('.pulls-detail-preview')).toBeNull()
  })

  it('selects an exact preview and copies those same bytes', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render()
    await flush()
    const details = host.querySelector<HTMLButtonElement>('.pulls-detail-button')
    expect(details?.disabled).toBe(false)
    act(() => details?.click())
    await flush()
    expect(host.textContent).toContain('@reviewer')
    expect(host.textContent).toContain('2026-10-02T00:00:00Z')
    expect(host.textContent).toContain('reviewed head-1')
    const checkbox = host.querySelector<HTMLInputElement>(
      '.pulls-detail input[type="checkbox"]',
    )
    expect(checkbox).not.toBeNull()
    act(() => checkbox?.click())
    const preview = host.querySelector('.pulls-detail-preview')?.textContent ?? ''
    expect(preview).toContain('Untrusted hosted GitHub feedback')
    expect(preview).toContain('Please revisit this')
    const copy = [
      ...host.querySelectorAll<HTMLButtonElement>('.pulls-detail button'),
    ].find((button) => button.textContent === 'Copy preview')
    expect(copy?.disabled).toBe(false)
    act(() => copy?.click())
    await flush()
    expect(writeText).toHaveBeenCalledWith(preview)
    expect(host.textContent).toContain('Exact preview copied.')
  })

  it('invalidates selected feedback when hidden and discards late detail results', async () => {
    let resolveDetail: (value: PullDetailResponse) => void = () => undefined
    detailResponse = new Promise<PullDetailResponse>((resolve) => {
      resolveDetail = resolve
    })
    render()
    await flush()
    act(() => host.querySelector<HTMLButtonElement>('.pulls-detail-button')?.click())
    render(true)
    resolveDetail({
      available: true,
      repo: 'acme/widgets',
      number: 1,
      title: 'Late',
      url: 'https://github.com/acme/widgets/pull/1',
      headOid: 'head-1',
      threadsPageComplete: true,
      payloadTruncated: false,
      threads: [],
    })
    await flush()
    expect(host.querySelector('.pulls-detail')).toBeNull()
  })

  it('discards pending details when the document is hidden', async () => {
    const value = await detailResponse
    let finish: (result: PullDetailResponse) => void = () => undefined
    detailResponse = new Promise((resolve) => {
      finish = resolve
    })
    render()
    await flush()
    act(() => host.querySelector<HTMLButtonElement>('.pulls-detail-button')?.click())
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    finish(value)
    await flush()
    expect(host.querySelector('[aria-label="Pull request feedback"]')).toBeNull()
  })

  it('allows a new detail request after switching roots during a pending read', async () => {
    const value = await detailResponse
    let finish: (result: PullDetailResponse) => void = () => undefined
    detailResponse = new Promise((resolve) => {
      finish = resolve
    })
    render()
    await flush()
    act(() => host.querySelector<HTMLButtonElement>('.pulls-detail-button')?.click())
    render(false, { root: hostPath(asHostId('local'), '/projects/other') })
    await flush()
    expect(host.querySelector<HTMLButtonElement>('.pulls-detail-button')?.disabled).toBe(
      false,
    )
    finish(value)
    await flush()
    expect(host.querySelector('[aria-label="Pull request feedback"]')).toBeNull()
    detailResponse = value
    act(() => host.querySelector<HTMLButtonElement>('.pulls-detail-button')?.click())
    await flush()
    expect(host.querySelector('[aria-label="Pull request feedback"]')).not.toBeNull()
  })

  it.each(['head', 'repository', 'unavailable'] as const)(
    'revokes the preview when refresh changes %s',
    async (change) => {
      await openFeedback()
      if (!response.available) throw new Error('Expected available fixture')
      response =
        change === 'unavailable'
          ? { available: false, reason: 'gh-unauthenticated', message: 'Sign in again' }
          : {
              ...response,
              ...(change === 'repository'
                ? { repo: 'other/widgets' }
                : {
                    branchPulls: [pull(1, { headOid: 'new-head' })],
                    authored: [],
                  }),
            }
      act(() => host.querySelector<HTMLButtonElement>('.pulls-refresh')?.click())
      await flush()
      expect(host.querySelector('.pulls-detail-preview')).toBeNull()
    },
  )

  it.each(['close', 'selection', 'disconnect', 'hide'] as const)(
    'ignores clipboard completion after %s',
    async (change) => {
      let finish: () => void = () => undefined
      const writeText = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      })
      await openFeedback()
      clickFeedbackButton('Copy preview')
      if (change === 'close') clickFeedbackButton('Close')
      if (change === 'selection')
        act(() => host.querySelector<HTMLInputElement>('.pulls-detail input')?.click())
      if (change === 'disconnect') render(false, { connected: false })
      if (change === 'hide') {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        act(() => {
          document.dispatchEvent(new Event('visibilitychange'))
        })
      }
      finish()
      await flush()
      expect(host.textContent).not.toContain('Exact preview copied.')
    },
  )

  it.each(['missing', 'throw', 'reject'] as const)(
    'shows clipboard %s as a recoverable error',
    async (failure) => {
      const writeText = () => {
        if (failure === 'throw') throw new Error('denied')
        return Promise.reject(new Error('denied'))
      }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: failure === 'missing' ? undefined : { writeText },
      })
      await openFeedback()
      clickFeedbackButton('Copy preview')
      await flush()
      expect(host.textContent).toContain('Clipboard copy was refused.')
      expect(host.querySelector('.pulls-detail-preview')?.textContent).toContain(
        'Please revisit this',
      )
    },
  )
})
