import { describe, expect, it } from 'vitest'

import {
  analyticsConfigFromEnv,
  analyticsConfigFor,
  gateTracesAgent,
  parseOmniCityFile,
  parseTracingGate,
  HONEYCOMB_LINK_DEFAULTS,
  OMNI_DEFAULT_BASE_URL,
  OMNI_DEFAULT_DASHBOARD_ID,
  OMNI_DEFAULT_RIG_FILTER_ID,
} from '../src/shared/gascity-analytics'

const OMNI_DEFAULTS = {
  baseUrl: OMNI_DEFAULT_BASE_URL,
  dashboardId: OMNI_DEFAULT_DASHBOARD_ID,
  rigFilterId: OMNI_DEFAULT_RIG_FILTER_ID,
}

describe('analyticsConfigFromEnv', () => {
  it('defaults to the deployed rig health dashboard and its rig filter', () => {
    expect(OMNI_DEFAULT_DASHBOARD_ID).toBe('gas-city-factory-rig-health')
    expect(OMNI_DEFAULT_RIG_FILTER_ID).toBe('QMdNGURu')
    expect(analyticsConfigFromEnv({}).omni).toStrictEqual({
      baseUrl: 'https://sjarmak.omniapp.co',
      dashboardId: 'gas-city-factory-rig-health',
      rigFilterId: 'QMdNGURu',
    })
  })

  it('shows both surfaces with the overlay defaults on an empty environment', () => {
    expect(analyticsConfigFromEnv({})).toEqual({
      honeycomb: HONEYCOMB_LINK_DEFAULTS,
      omni: OMNI_DEFAULTS,
    })
  })

  it('applies and trims each Honeycomb override', () => {
    const config = analyticsConfigFromEnv({
      HONEYCOMB_TEAM: ' acme ',
      HONEYCOMB_ENVIRONMENT: 'prod',
      HONEYCOMB_TRACE_DATASET: 'agents.v2',
    })
    expect(config.honeycomb).toEqual({
      team: 'acme',
      environment: 'prod',
      dataset: 'agents.v2',
    })
  })

  it('treats an empty or whitespace variable as unset', () => {
    expect(analyticsConfigFromEnv({ HONEYCOMB_TEAM: '' }).honeycomb).toEqual(
      HONEYCOMB_LINK_DEFAULTS,
    )
    expect(analyticsConfigFromEnv({ HONEYCOMB_TEAM: '   ' }).honeycomb).toEqual(
      HONEYCOMB_LINK_DEFAULTS,
    )
    expect(analyticsConfigFromEnv({ OMNI_BASE_URL: '' }).omni).toEqual(OMNI_DEFAULTS)
    expect(analyticsConfigFromEnv({ OMNI_DASHBOARD_ID: ' ' }).omni).toEqual(OMNI_DEFAULTS)
  })

  it('hides Honeycomb on the literal off, in any case', () => {
    expect(analyticsConfigFromEnv({ HONEYCOMB_TEAM: 'off' }).honeycomb).toBeUndefined()
    expect(
      analyticsConfigFromEnv({ HONEYCOMB_TRACE_DATASET: 'OFF' }).honeycomb,
    ).toBeUndefined()
  })

  it('hides Honeycomb on an explicit value that is not a safe path segment', () => {
    expect(
      analyticsConfigFromEnv({ HONEYCOMB_TEAM: 'steph jarmak' }).honeycomb,
    ).toBeUndefined()
    expect(
      analyticsConfigFromEnv({ HONEYCOMB_ENVIRONMENT: 'a/b' }).honeycomb,
    ).toBeUndefined()
    expect(
      analyticsConfigFromEnv({ HONEYCOMB_TRACE_DATASET: 'x'.repeat(65) }).honeycomb,
    ).toBeUndefined()
  })

  it('keeps the Omni surface untouched when Honeycomb is hidden, and vice versa', () => {
    expect(analyticsConfigFromEnv({ HONEYCOMB_TEAM: 'off' }).omni).toEqual(OMNI_DEFAULTS)
    expect(analyticsConfigFromEnv({ OMNI_BASE_URL: 'off' }).honeycomb).toEqual(
      HONEYCOMB_LINK_DEFAULTS,
    )
  })

  it('keeps a custom https origin without the default workspace ids, normalising a trailing slash', () => {
    expect(
      analyticsConfigFromEnv({ OMNI_BASE_URL: 'https://acme.omniapp.co/' }).omni,
    ).toStrictEqual({ baseUrl: 'https://acme.omniapp.co' })
  })

  it('hides Omni on anything but a bare https origin', () => {
    for (const value of [
      'http://acme.omniapp.co',
      'https://acme.omniapp.co/dashboards',
      'https://user:pw@acme.omniapp.co',
      'https://acme.omniapp.co/?x=1',
      'https://acme.omniapp.co/#top',
      'off',
    ]) {
      expect(analyticsConfigFromEnv({ OMNI_BASE_URL: value }).omni, value).toBeUndefined()
    }
  })

  it('passes the Omni dashboard and rig filter ids through only when safe', () => {
    expect(
      analyticsConfigFromEnv({
        OMNI_DASHBOARD_ID: 'abc123',
        OMNI_RIG_FILTER_ID: 'rig_name',
      }).omni,
    ).toEqual({
      baseUrl: OMNI_DEFAULT_BASE_URL,
      dashboardId: 'abc123',
      rigFilterId: 'rig_name',
    })
    expect(
      analyticsConfigFromEnv({ OMNI_DASHBOARD_ID: 'a b', OMNI_RIG_FILTER_ID: 'rig_name' })
        .omni,
    ).toEqual({ baseUrl: OMNI_DEFAULT_BASE_URL, rigFilterId: 'rig_name' })
    expect(
      analyticsConfigFromEnv({ OMNI_DASHBOARD_ID: 'abc123', OMNI_RIG_FILTER_ID: 'x?y' })
        .omni,
    ).toEqual({ baseUrl: OMNI_DEFAULT_BASE_URL, dashboardId: 'abc123' })
  })

  it('drops a default Omni id on the literal off, leaving the link unfiltered', () => {
    expect(analyticsConfigFromEnv({ OMNI_RIG_FILTER_ID: 'off' }).omni).toStrictEqual({
      baseUrl: OMNI_DEFAULT_BASE_URL,
      dashboardId: OMNI_DEFAULT_DASHBOARD_ID,
    })
    expect(
      analyticsConfigFromEnv({ OMNI_DASHBOARD_ID: 'OFF', OMNI_RIG_FILTER_ID: 'off' })
        .omni,
    ).toStrictEqual({ baseUrl: OMNI_DEFAULT_BASE_URL })
  })

  it('applies explicit ids on a custom origin', () => {
    expect(
      analyticsConfigFromEnv({
        OMNI_BASE_URL: 'https://acme.omniapp.co',
        OMNI_DASHBOARD_ID: 'd1',
        OMNI_RIG_FILTER_ID: 'f1',
      }).omni,
    ).toStrictEqual({
      baseUrl: 'https://acme.omniapp.co',
      dashboardId: 'd1',
      rigFilterId: 'f1',
    })
  })

  it('never carries an API key into the config', () => {
    const config = analyticsConfigFromEnv({
      HONEYCOMB_API_KEY: 'hcaik_secret_value',
      OMNI_AGENT_API_KEY: 'omni_secret_value',
    })
    const json = JSON.stringify(config)
    expect(json).not.toContain('API_KEY')
    expect(json).not.toContain('secret_value')
  })
})

describe('parseTracingGate', () => {
  it('reads every agent a well-formed gate names', () => {
    expect(parseTracingGate('mayor:claude\nmayor:codex\n*:nebius')).toEqual({
      agents: ['mayor', '*'],
    })
  })

  it('voids the whole file on a blank or malformed line, as gas-city does', () => {
    expect(parseTracingGate('mayor:claude\n\nworker:codex\n')).toBeUndefined()
    expect(parseTracingGate('mayor:gpt\n')).toBeUndefined()
    expect(parseTracingGate('')).toBeUndefined()
  })

  it('matches a named agent or any agent under a wildcard', () => {
    expect(gateTracesAgent({ agents: ['mayor'] }, 'mayor')).toBe(true)
    expect(gateTracesAgent({ agents: ['mayor'] }, 'worker-1')).toBe(false)
    expect(gateTracesAgent({ agents: ['*'] }, 'worker-1')).toBe(true)
  })
})

describe('parseOmniCityFile', () => {
  it('reads an origin alone or with the city dashboard and rig filter', () => {
    expect(parseOmniCityFile('https://sjarmak.omniapp.co\n')).toEqual({
      origin: 'https://sjarmak.omniapp.co',
    })
    expect(
      parseOmniCityFile(
        'https://sjarmak.omniapp.co\ndashboard=city-activity\nrig_filter=ab12\n',
      ),
    ).toEqual({
      origin: 'https://sjarmak.omniapp.co',
      dashboardId: 'city-activity',
      rigFilterId: 'ab12',
    })
  })

  it('rejects unknown keys, repeats and unsafe ids', () => {
    expect(parseOmniCityFile('https://a.omniapp.co\nfoo=bar')).toBeUndefined()
    expect(
      parseOmniCityFile('https://a.omniapp.co\ndashboard=a\ndashboard=b'),
    ).toBeUndefined()
    expect(parseOmniCityFile('https://a.omniapp.co\ndashboard=a b')).toBeUndefined()
    expect(parseOmniCityFile('')).toBeUndefined()
  })
})

describe('analyticsConfigFor', () => {
  it('opens the city dashboard without the fleet rig filter when the city names one', () => {
    expect(
      analyticsConfigFor(
        {},
        { omniCity: 'https://sjarmak.omniapp.co\ndashboard=city-activity' },
      ).omni,
    ).toStrictEqual({
      baseUrl: 'https://sjarmak.omniapp.co',
      dashboardId: 'city-activity',
    })
  })

  it('keeps the default dashboard and filter for a city that names only the origin', () => {
    expect(
      analyticsConfigFor({}, { omniCity: 'https://sjarmak.omniapp.co' }).omni,
    ).toStrictEqual(OMNI_DEFAULTS)
  })
})
