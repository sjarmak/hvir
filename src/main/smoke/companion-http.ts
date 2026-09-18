/**
 * A loopback HTTP client for the Companion scenario: one request per socket
 * (no keep-alive pool), so a closed listener answers with a refused
 * connection rather than a reused socket hanging up.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http'

import type { CompanionSnapshot } from '../../shared'

export interface CompanionReply {
  readonly status: number | undefined
  readonly headers: IncomingMessage['headers']
  readonly body: string
}

export function expectStatus(reply: CompanionReply, status: number, what: string): void {
  if (reply.status !== status) {
    throw new Error(`${what} answered ${reply.status}, expected ${status}: ${reply.body}`)
  }
}

export function send(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<CompanionReply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const headers = {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    }
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      agent: false,
      headers,
    })
    request.on('response', (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body }),
      )
    })
    request.on('error', reject)
    request.end(payload)
  })
}

export interface CompanionEventsStream {
  readonly pageId: string
  readonly firstSnapshot: () => Promise<CompanionSnapshot>
  readonly close: () => void
}

export function openEvents(
  port: number,
  headers: Record<string, string>,
): Promise<CompanionEventsStream> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/events',
      agent: false,
      headers,
    })
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`GET /api/events answered ${response.statusCode}`))
        return
      }
      let buffer = ''
      const snapshot = new Promise<CompanionSnapshot>((done, fail) => {
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          buffer += chunk
          const match = /event: snapshot\ndata: (.*)\n\n/.exec(buffer)
          if (match) done(JSON.parse(match[1]!) as CompanionSnapshot)
        })
        response.on('error', fail)
      })
      resolve({
        pageId: String(response.headers['x-companion-page'] ?? ''),
        firstSnapshot: () => snapshot,
        close: () => request.destroy(),
      })
    })
    request.on('error', reject)
    request.end()
  })
}
