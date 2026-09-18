import { describe, expect, it } from 'vitest'

import { CompanionRouter } from '../src/main/companion/companion-router'

function router(): CompanionRouter {
  const routes = new CompanionRouter()
  routes.register('GET', '/', () => undefined)
  routes.register('GET', '/assets/*', () => undefined)
  routes.register('POST', '/pair', () => undefined)
  routes.register('GET', '/api/sessions', () => undefined)
  routes.register('POST', '/api/sessions/:handle/select', () => undefined)
  return routes
}

describe('CompanionRouter', () => {
  it('matches an exact path with no params', () => {
    const match = router().resolve('GET', '/')
    expect(match.kind).toBe('matched')
    if (match.kind !== 'matched') throw new Error('expected a match')
    expect(match.params).toEqual({})
  })

  it('ignores the query string when matching', () => {
    const match = router().resolve('GET', '/api/sessions?page=abc')
    expect(match.kind).toBe('matched')
  })

  it('extracts a decoded :handle param', () => {
    const match = router().resolve('POST', '/api/sessions/term%3A42/select')
    expect(match.kind).toBe('matched')
    if (match.kind !== 'matched') throw new Error('expected a match')
    expect(match.params).toEqual({ handle: 'term:42' })
  })

  it('captures the remainder of a wildcard route', () => {
    const match = router().resolve('GET', '/assets/index-abc123.js')
    expect(match.kind).toBe('matched')
    if (match.kind !== 'matched') throw new Error('expected a match')
    expect(match.params).toEqual({ '*': 'index-abc123.js' })
    expect(router().resolve('GET', '/assets/').kind).toBe('not-found')
  })

  it('answers 405 with the allowed methods for a known path', () => {
    const match = router().resolve('POST', '/api/sessions')
    expect(match).toEqual({ kind: 'method-not-allowed', allow: ['GET'] })
    expect(router().resolve('GET', '/pair')).toEqual({
      kind: 'method-not-allowed',
      allow: ['POST'],
    })
  })

  it('answers 404 for an unknown path', () => {
    expect(router().resolve('GET', '/nope').kind).toBe('not-found')
    expect(router().resolve('GET', '/api/sessions/only-handle').kind).toBe('not-found')
    expect(router().resolve('GET', '/api/sessions/a/select/extra').kind).toBe('not-found')
  })

  it('rejects an undecodable param as not found', () => {
    expect(router().resolve('POST', '/api/sessions/%E0%A4%A/select').kind).toBe(
      'not-found',
    )
  })

  it('refuses a duplicate registration', () => {
    const routes = router()
    expect(() => routes.register('GET', '/', () => undefined)).toThrow(
      'already registered',
    )
  })

  it('lists the exact route table', () => {
    expect(router().routes()).toEqual([
      'GET /',
      'GET /assets/*',
      'POST /pair',
      'GET /api/sessions',
      'POST /api/sessions/:handle/select',
    ])
  })
})
