/**
 * A closed route table for the Companion listener: method plus a path pattern
 * with `:name` segments and one trailing `*`. The server owns the static and
 * pairing rows; the sessions child registers the /api rows through it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { SseWriter } from './companion-http'

export type CompanionMethod = 'GET' | 'POST'

export interface CompanionRequestContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  /** Turns the response into a server-tracked text/event-stream. */
  readonly openEventStream: (headers?: Readonly<Record<string, string>>) => SseWriter
}

export type CompanionRouteHandler = (
  context: CompanionRequestContext,
) => Promise<void> | void

export type CompanionRouteMatch =
  | {
      readonly kind: 'matched'
      readonly handler: CompanionRouteHandler
      readonly params: Readonly<Record<string, string>>
    }
  | { readonly kind: 'method-not-allowed'; readonly allow: readonly CompanionMethod[] }
  | { readonly kind: 'not-found' }

interface CompanionRoute {
  readonly method: CompanionMethod
  readonly pattern: string
  readonly segments: readonly string[]
  readonly handler: CompanionRouteHandler
}

export class CompanionRouter {
  private readonly table: CompanionRoute[] = []

  register(
    method: CompanionMethod,
    pattern: string,
    handler: CompanionRouteHandler,
  ): void {
    if (!pattern.startsWith('/'))
      throw new Error(`Companion route must start with /: ${pattern}`)
    if (
      this.table.some((route) => route.method === method && route.pattern === pattern)
    ) {
      throw new Error(`Companion route already registered: ${method} ${pattern}`)
    }
    const segments = splitPath(pattern)
    if (segments.indexOf('*') !== -1 && segments.indexOf('*') !== segments.length - 1) {
      throw new Error(`Companion wildcard must be the last segment: ${pattern}`)
    }
    this.table.push({ method, pattern, segments, handler })
  }

  routes(): readonly string[] {
    return this.table.map((route) => `${route.method} ${route.pattern}`)
  }

  resolve(method: string, target: string): CompanionRouteMatch {
    const segments = splitPath(target.split('?', 1)[0] ?? '')
    const allow: CompanionMethod[] = []
    for (const route of this.table) {
      const params = matchSegments(route.segments, segments)
      if (!params) continue
      if (route.method === method)
        return { kind: 'matched', handler: route.handler, params }
      allow.push(route.method)
    }
    return allow.length > 0
      ? { kind: 'method-not-allowed', allow }
      : { kind: 'not-found' }
  }
}

function splitPath(pathname: string): readonly string[] {
  return pathname === '/' ? [] : pathname.split('/').slice(1)
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | undefined {
  const params: Record<string, string> = {}
  for (const [index, expected] of pattern.entries()) {
    if (expected === '*') {
      const rest = actual.slice(index).join('/')
      if (rest.length === 0) return undefined
      params['*'] = rest
      return params
    }
    const segment = actual[index]
    if (segment === undefined || segment.length === 0) return undefined
    if (expected.startsWith(':')) {
      const decoded = decodeSegment(segment)
      if (decoded === undefined) return undefined
      params[expected.slice(1)] = decoded
    } else if (expected !== segment) {
      return undefined
    }
  }
  return actual.length === pattern.length ? params : undefined
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}
