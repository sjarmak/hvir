/**
 * A Companion page's event stream kept open for a whole scenario (ADR-050):
 * every SSE frame is parsed as it arrives and can be awaited by name and
 * shape. Mirror bytes are dropped at the parser: an `output` frame leaves
 * only its arrival time and an `opened` frame its geometry, so nothing this
 * module retains, returns, or puts into an error can carry PTY output.
 */
import { request as httpRequest } from 'node:http'

import { waitFor } from './attention-away-probe'

export interface CompanionEventFrame {
  readonly event: string
  /** The frame's JSON, with mirror bytes removed from terminal frames. */
  readonly data: unknown
}

export interface CompanionEventFrames {
  readonly pageId: string
  /** The first frame named `event` (already received or still to come) the predicate accepts. */
  waitFor(
    event: string,
    predicate: (data: unknown) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<unknown>
  /** When the newest mirror `output` frame arrived; 0 before the first. */
  lastOutputAt(): number
  /** Frame names in arrival order; terminal frames as `terminal:<type>`. */
  sequence(): readonly string[]
  close(): void
}

export function openEventFrames(
  port: number,
  headers: Record<string, string>,
): Promise<CompanionEventFrames> {
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
      const frames: CompanionEventFrame[] = []
      let lastOutputAt = 0
      let buffer = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        buffer += chunk
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = parseFrame(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          if (frame === undefined) continue
          if (isMirrorOutput(frame)) lastOutputAt = Date.now()
          frames.push(withoutMirrorBytes(frame))
        }
      })
      resolve({
        pageId: String(response.headers['x-companion-page'] ?? ''),
        waitFor: async (event, predicate, timeoutMs, what) => {
          let seen = 0
          let found: CompanionEventFrame | undefined
          await waitFor(
            () => {
              for (; seen < frames.length; seen += 1) {
                const frame = frames[seen]!
                if (frame.event === event && predicate(frame.data)) {
                  found = frame
                  seen += 1
                  return true
                }
              }
              return false
            },
            timeoutMs,
            `companion events: no ${event} frame ${what} within ${timeoutMs}ms`,
          )
          return found?.data
        },
        lastOutputAt: () => lastOutputAt,
        sequence: () => frames.map(frameName),
        close: () => request.destroy(),
      })
    })
    request.on('error', reject)
    request.end()
  })
}

function parseFrame(raw: string): CompanionEventFrame | undefined {
  const lines = raw.split('\n')
  const event = lines.find((line) => line.startsWith('event: '))?.slice(7)
  const data = lines.find((line) => line.startsWith('data: '))?.slice(6)
  if (event === undefined || data === undefined) return undefined
  return { event, data: JSON.parse(data) as unknown }
}

function terminalType(frame: CompanionEventFrame): string | undefined {
  if (frame.event !== 'terminal') return undefined
  const data = frame.data
  if (typeof data !== 'object' || data === null) return undefined
  const type = (data as { readonly type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}

function isMirrorOutput(frame: CompanionEventFrame): boolean {
  return terminalType(frame) === 'output'
}

/** Keeps every field of a terminal frame except the ones that carry PTY bytes. */
function withoutMirrorBytes(frame: CompanionEventFrame): CompanionEventFrame {
  const type = terminalType(frame)
  if (type !== 'output' && type !== 'opened') return frame
  const {
    data: _data,
    tail: _tail,
    preamble: _preamble,
    ...rest
  } = frame.data as Record<string, unknown>
  return { event: frame.event, data: rest }
}

function frameName(frame: CompanionEventFrame): string {
  const type = terminalType(frame)
  return type === undefined ? frame.event : `${frame.event}:${type}`
}
