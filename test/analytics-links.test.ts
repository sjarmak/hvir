import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  agentName,
  beadStore,
  beadTraceUrl,
  beadWorkId,
  escapeNonAscii,
  honeycombQueryUrl,
  omniAnalyticsUrl,
  sessionTraceUrl,
  TRACE_LOOKBACK_SECONDS,
  traceLinkTitle,
  workIdInput,
} from '../src/renderer/src/beads/analytics-links'
import type { HoneycombLinkConfig, OmniLinkConfig } from '../src/shared'

const HONEYCOMB: HoneycombLinkConfig = {
  team: 'steph.jarmak',
  environment: 'test',
  dataset: 'gas-city-agent',
}
const OMNI: OmniLinkConfig = { baseUrl: 'https://sjarmak.omniapp.co' }

function querySpec(url: string): Record<string, unknown> {
  const raw = new URL(url).searchParams.get('query')
  expect(raw).not.toBeNull()
  return JSON.parse(raw as string) as Record<string, unknown>
}

function assertClean(url: string): void {
  expect(new URL(url).protocol).toBe('https:')
  expect(url).not.toMatch(/key|token/i)
}

describe('honeycombQueryUrl', () => {
  it('encodes the path segments and round-trips the query spec', () => {
    const url = honeycombQueryUrl({ team: 'a b', environment: 'e/1', dataset: 'd' }, [
      { column: 'gc.rig', op: '=', value: 'mem' },
    ])
    expect(
      url.startsWith(
        'https://ui.honeycomb.io/a%20b/environments/e%2F1/datasets/d/?query=',
      ),
    ).toBe(true)
    expect(querySpec(url)).toEqual({
      calculations: [{ op: 'COUNT' }],
      filters: [{ column: 'gc.rig', op: '=', value: 'mem' }],
      filter_combination: 'AND',
      breakdowns: ['gen_ai.operation.name'],
      time_range: TRACE_LOOKBACK_SECONDS,
    })
    assertClean(url)
  })

  it('accepts an explicit time range', () => {
    expect(querySpec(honeycombQueryUrl(HONEYCOMB, [], 60)).time_range).toBe(60)
  })
})

describe('agentName', () => {
  it('strips a rig-qualified template to its basename', () => {
    expect(agentName('mem', { name: 'x', template: 'mem/polecat' })).toBe('mem.polecat')
  })

  it('falls back to the session name', () => {
    expect(agentName('mem', { name: 'mem-worker-ash' })).toBe('mem.mem-worker-ash')
  })

  it('refuses names gas-city would not have exported', () => {
    expect(agentName('mem', { name: 'a b' })).toBeUndefined()
    expect(agentName('mem', { name: 'a'.repeat(65) })).toBeUndefined()
    expect(agentName('me m', { name: 'polecat' })).toBeUndefined()
    expect(agentName('mem', { name: 'mem/' })).toBeUndefined()
  })
})

describe('sessionTraceUrl', () => {
  it('is undefined when the agent name cannot be formed', () => {
    expect(sessionTraceUrl(HONEYCOMB, 'mem', { name: 'a b' })).toBeUndefined()
  })

  it('carries exactly the agent and rig filters', () => {
    const url = sessionTraceUrl(HONEYCOMB, 'mem', { name: 'x', template: 'mem/polecat' })
    expect(url).toBeDefined()
    expect(querySpec(url as string).filters).toEqual([
      { column: 'gen_ai.agent.name', op: '=', value: 'mem.polecat' },
      { column: 'gc.rig', op: '=', value: 'mem' },
    ])
    assertClean(url as string)
  })
})

describe('beadTraceUrl', () => {
  it('carries exactly the work id and rig filters for a rig store', () => {
    const url = beadTraceUrl(HONEYCOMB, { kind: 'rig', name: 'mem' }, 'abc')
    expect(querySpec(url).filters).toEqual([
      { column: 'gc.work.id', op: '=', value: 'abc' },
      { column: 'gc.rig', op: '=', value: 'mem' },
    ])
    assertClean(url)
  })

  it('carries only the work id filter for a city store', () => {
    const url = beadTraceUrl(HONEYCOMB, { kind: 'city', name: 'hq' }, 'abc')
    expect(querySpec(url).filters).toEqual([
      { column: 'gc.work.id', op: '=', value: 'abc' },
    ])
    assertClean(url)
  })
})

describe('beadStore', () => {
  const base = { available: true as const, members: [], tierSource: 'config' as const }
  const diagnostics = { namedSessions: 0, pinned: 0, unmatched: [] }

  it('is the rig store for a rig workspace that named its rig', () => {
    expect(beadStore({ ...base, diagnostics, scope: 'rig', rigName: 'mem' })).toEqual({
      kind: 'rig',
      name: 'mem',
    })
  })

  it('is the city store, named after the hq rig, for a city workspace', () => {
    expect(
      beadStore({ ...base, diagnostics, scope: 'city', rigName: 'hq', hqRigName: 'hq' }),
    ).toEqual({ kind: 'city', name: 'hq' })
  })

  it('is unknown when the provenance cannot be named', () => {
    expect(beadStore({ ...base, diagnostics, scope: 'rig' })).toBeUndefined()
    expect(
      beadStore({ ...base, diagnostics, scope: 'city', rigName: 'hq' }),
    ).toBeUndefined()
    expect(beadStore(undefined)).toBeUndefined()
  })
})

describe('work id derivation', () => {
  it('matches json.dumps with compact separators byte for byte', () => {
    expect(workIdInput('rig:mem', 'mem-42')).toBe('["work","rig:mem","mem-42"]')
  })

  it('escapes non-ASCII the way ensure_ascii does', () => {
    expect(escapeNonAscii('é')).toBe('\\u00e9')
    expect(escapeNonAscii(`a${String.fromCharCode(0x7f)}`)).toBe('a\\u007f')
    expect(escapeNonAscii('\u{1F600}')).toBe('\\ud83d\\ude00')
    expect(escapeNonAscii('plain')).toBe('plain')
    expect(workIdInput('rig:mem', 'é')).toBe('["work","rig:mem","\\u00e9"]')
  })

  it('hashes to the sha256 of the ensure_ascii JSON', async () => {
    const expected = createHash('sha256')
      .update('["work","rig:mem","mem-42"]')
      .digest('hex')
    await expect(beadWorkId('rig:mem', 'mem-42')).resolves.toBe(expected)
  })
})

describe('omniAnalyticsUrl', () => {
  it('lands on the model home without a dashboard id', () => {
    const url = omniAnalyticsUrl(OMNI, 'mem')
    expect(url).toBe('https://sjarmak.omniapp.co')
    assertClean(url)
  })

  it('opens the dashboard when configured', () => {
    expect(omniAnalyticsUrl({ ...OMNI, dashboardId: 'd 1' }, 'mem')).toBe(
      'https://sjarmak.omniapp.co/dashboards/d%201',
    )
  })

  it('filters on the rig only when both filter id and rig are present', () => {
    const filtered = omniAnalyticsUrl(
      { ...OMNI, dashboardId: 'd1', rigFilterId: 'rig' },
      'mem',
    )
    expect(filtered).toBe(
      `https://sjarmak.omniapp.co/dashboards/d1?f--rig=${encodeURIComponent('{"values":["mem"]}')}`,
    )
    assertClean(filtered)
    expect(omniAnalyticsUrl({ ...OMNI, dashboardId: 'd1', rigFilterId: 'rig' })).toBe(
      'https://sjarmak.omniapp.co/dashboards/d1',
    )
    expect(omniAnalyticsUrl(OMNI, 'mem')).not.toContain('f--')
  })
})

describe('traceLinkTitle', () => {
  it('states the window the query covers', () => {
    expect(traceLinkTitle('mem.polecat')).toBe(
      'Honeycomb: spans for mem.polecat, last 2h from when opened',
    )
  })
})
