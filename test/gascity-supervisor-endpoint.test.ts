import { describe, expect, it } from 'vitest'

import {
  GASCITY_SUPERVISOR_DEFAULT_ENDPOINT,
  supervisorCityNameForRoot,
  supervisorEndpointFor,
  supervisorVariableForHost,
} from '../src/main/gascity/supervisor-endpoint'
import type { CityInfo } from '../src/main/gascity/generated-supervisor-api'
import { asHostId } from '../src/shared'

const LOCAL = asHostId('local')
const REMOTE = asHostId('ssh-build-box')

function city(name: string, path: string): CityInfo {
  return { name, path } as CityInfo
}

describe('gas city supervisor endpoint', () => {
  it('uses the documented loopback default when nothing is declared', () => {
    expect(supervisorEndpointFor(LOCAL, {})).toEqual({
      kind: 'endpoint',
      endpoint: GASCITY_SUPERVISOR_DEFAULT_ENDPOINT,
    })
    expect(GASCITY_SUPERVISOR_DEFAULT_ENDPOINT).toEqual({
      hostname: '127.0.0.1',
      port: 8372,
    })
  })

  it('names one variable per host', () => {
    expect(supervisorVariableForHost(REMOTE)).toBe(
      'HVIR_GASCITY_SUPERVISOR_SSH_BUILD_BOX',
    )
    expect(supervisorVariableForHost(LOCAL)).toBe('HVIR_GASCITY_SUPERVISOR_LOCAL')
  })

  it('prefers the host variable over the shared one', () => {
    const env = {
      HVIR_GASCITY_SUPERVISOR: '9001',
      HVIR_GASCITY_SUPERVISOR_SSH_BUILD_BOX: '127.0.0.1:9100',
    }
    expect(supervisorEndpointFor(REMOTE, env)).toEqual({
      kind: 'endpoint',
      endpoint: { hostname: '127.0.0.1', port: 9100 },
    })
    expect(supervisorEndpointFor(LOCAL, env)).toEqual({
      kind: 'endpoint',
      endpoint: { hostname: '127.0.0.1', port: 9001 },
    })
  })

  it('treats a blank declaration as no declaration', () => {
    expect(
      supervisorEndpointFor(REMOTE, {
        HVIR_GASCITY_SUPERVISOR_SSH_BUILD_BOX: '   ',
        HVIR_GASCITY_SUPERVISOR: '9001',
      }),
    ).toEqual({ kind: 'endpoint', endpoint: { hostname: '127.0.0.1', port: 9001 } })
  })

  it('turns the surface off on the literal off value', () => {
    expect(supervisorEndpointFor(LOCAL, { HVIR_GASCITY_SUPERVISOR: 'OFF' })).toEqual({
      kind: 'disabled',
    })
    expect(
      supervisorEndpointFor(REMOTE, {
        HVIR_GASCITY_SUPERVISOR_SSH_BUILD_BOX: 'off',
        HVIR_GASCITY_SUPERVISOR: '9001',
      }),
    ).toEqual({ kind: 'disabled' })
  })

  it('accepts ::1 and localhost, and reports anything else as misconfigured', () => {
    expect(
      supervisorEndpointFor(LOCAL, { HVIR_GASCITY_SUPERVISOR: '[::1]:8372' }),
    ).toEqual({
      kind: 'endpoint',
      endpoint: { hostname: '::1', port: 8372 },
    })
    expect(
      supervisorEndpointFor(LOCAL, { HVIR_GASCITY_SUPERVISOR: 'localhost:8372' }),
    ).toEqual({ kind: 'endpoint', endpoint: { hostname: 'localhost', port: 8372 } })
    for (const value of ['10.0.0.4:8372', 'example.com:8372', '127.0.0.1', '0', '70000'])
      expect(supervisorEndpointFor(LOCAL, { HVIR_GASCITY_SUPERVISOR: value })).toEqual({
        kind: 'invalid',
        variable: 'HVIR_GASCITY_SUPERVISOR',
      })
  })

  it('joins a project root to exactly one city name', () => {
    const cities = [
      city('mem', '/home/dev/city/rigs/mem'),
      city('ops', '/home/dev/city/rigs/ops'),
    ]
    expect(supervisorCityNameForRoot(cities, '/home/dev/city/rigs/mem/')).toBe('mem')
    expect(supervisorCityNameForRoot(cities, '/home/dev/city/rigs/other')).toBeUndefined()
  })

  it('refuses to guess when two cities claim one path', () => {
    const cities = [city('mem', '/home/dev/city'), city('mirror', '/home/dev/city')]
    expect(supervisorCityNameForRoot(cities, '/home/dev/city')).toBeUndefined()
  })
})
