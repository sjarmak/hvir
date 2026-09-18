// @vitest-environment happy-dom

/**
 * The Companion page mounted against the fake listener, for page tests: one
 * root per test, the desktop bridge trapped (ADR-049 module boundary), and
 * the verbs a test drives by hand. `useCompanionPage()` registers the hooks;
 * the bindings below are live for the current test.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach } from 'vitest'

import { CompanionApp } from '../src/renderer/companion/src/App'
import {
  COMPANION_TOKEN_STORAGE_KEY,
  browserTokenStore,
  createCompanionClient,
} from '../src/renderer/companion/src/companion-client'
import {
  FakeCompanionServer,
  fakePaneFactory,
  row,
  snapshot,
  transcript,
} from './companion-page-fixture'

export let host: HTMLDivElement
export let server: FakeCompanionServer
export let panes: ReturnType<typeof fakePaneFactory>
let root: Root

export function useCompanionPage(): void {
  beforeEach(() => {
    ;(
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    server = new FakeCompanionServer()
    panes = fakePaneFactory()
    // The page must never reach for the desktop bridge (ADR-049 module boundary).
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      get: () => {
        throw new Error('window.hvir was read by the Companion page')
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete (window as unknown as { hvir?: unknown }).hvir
    delete (document as unknown as { hidden?: unknown }).hidden
  })
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

export async function render(): Promise<void> {
  const client = createCompanionClient({
    fetch: server.fetch,
    tokens: browserTokenStore(() => localStorage),
  })
  await act(async () => {
    root.render(createElement(CompanionApp, { client, createPane: panes.createPane }))
    await Promise.resolve()
  })
  await settle()
}

export async function renderPaired(): Promise<void> {
  localStorage.setItem(COMPANION_TOKEN_STORAGE_KEY, server.token)
  await render()
}

/** Unmounts the page and leaves a fresh root behind for the hook's own unmount. */
export function unmountPage(): void {
  act(() => root.unmount())
  root = createRoot(host)
}

export async function emit(event: string, data: unknown): Promise<void> {
  act(() => {
    server.emit(event, data)
  })
  await settle()
}

export function button(label: string): HTMLButtonElement {
  const element = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (element === undefined) throw new Error(`missing button ${label}`)
  return element
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
  await settle()
}

export async function type(selector: string, value: string): Promise<void> {
  await act(async () => {
    const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
    if (element === null) throw new Error(`missing ${selector}`)
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

export function rowHandles(): string[] {
  return [...host.querySelectorAll<HTMLElement>('.companion-row')].map(
    (element) => element.dataset['handle'] ?? '',
  )
}

export async function hide(): Promise<void> {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
  })
  await settle()
}

export const MIRROR_ROW = row({
  handle: 'term-1',
  title: 'claude in shell',
  origin: { kind: 'hvir-terminal' },
  canAnswer: false,
  canMirror: true,
})

export const NOT_PROJECTED = transcript({
  handle: 'term-1',
  status: 'unavailable',
  reason: 'not-projected',
  stream: 'closed',
})

/** Pairs, selects the mirror row and opens its mirror at 132x43 with `tail`. */
export async function openMirror(tail = '$ '): Promise<void> {
  server.transcriptReply = NOT_PROJECTED
  await renderPaired()
  await emit('snapshot', snapshot(1, [MIRROR_ROW]))
  await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
  await emit('terminal', { type: 'opened', handle: 'term-1', cols: 132, rows: 43, tail })
}

export function armButton(): HTMLButtonElement {
  const element = host.querySelector<HTMLButtonElement>('.companion-arm')
  if (element === null) throw new Error('missing arm control')
  return element
}
