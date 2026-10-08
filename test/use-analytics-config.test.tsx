// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { useAnalyticsConfig } from '../src/renderer/src/beads/use-analytics-config'
import {
  asHostId,
  hostPath,
  type GasCityAnalyticsConfig,
  type HostPath,
} from '../src/shared'

const CONFIG: GasCityAnalyticsConfig = {
  honeycomb: {
    team: 'steph.jarmak',
    environment: 'test',
    dataset: 'gas-city-agent',
    agents: ['*'],
  },
}
const CITY = hostPath(asHostId('local'), '/home/dev/city')
const OTHER = hostPath(asHostId('local'), '/home/dev/other')

let host: HTMLDivElement
let root: Root
let invoke: Mock<(channel: string, payload?: unknown) => Promise<unknown>>
let seen: GasCityAnalyticsConfig | undefined

beforeEach(() => {
  ;(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  seen = undefined
  invoke = vi.fn(() => Promise.resolve(CONFIG))
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.hvir = {
    invoke,
    on: () => () => undefined,
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function Probe({
  enabled,
  at,
}: {
  readonly enabled: boolean
  readonly at: HostPath
}): ReactElement {
  seen = useAnalyticsConfig(at, enabled)
  return createElement('div')
}

async function render(enabled: boolean, at: HostPath = CITY): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { enabled, at }))
    await Promise.resolve()
  })
}

describe('useAnalyticsConfig', () => {
  it('does not ask while disabled', async () => {
    await render(false)
    expect(invoke).not.toHaveBeenCalled()
    expect(seen).toBeUndefined()
  })

  it('asks exactly once when enabled and exposes the answer', async () => {
    await render(false)
    await render(true)
    await render(false)
    await render(true)
    expect(invoke.mock.calls).toEqual([['gascity:analytics-config', { root: CITY }]])
    expect(seen).toEqual(CONFIG)
  })

  it('asks again for a different workspace and hides the previous answer meanwhile', async () => {
    await render(true)
    expect(seen).toEqual(CONFIG)
    let answer: (config: GasCityAnalyticsConfig) => void = () => undefined
    invoke.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve as typeof answer)),
    )
    await render(true, OTHER)
    expect(invoke).toHaveBeenLastCalledWith('gascity:analytics-config', { root: OTHER })
    expect(seen).toBeUndefined()
    await act(async () => {
      answer({})
      await Promise.resolve()
    })
    expect(seen).toEqual({})
  })

  it('stays undefined when the invoke fails, warns, and re-asks on the next enable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    invoke.mockImplementationOnce(() => Promise.reject(new Error('bridge down')))
    await render(true)
    expect(seen).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)

    await render(false)
    await render(true)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(CONFIG)
  })
})
