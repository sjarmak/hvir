import { describe, expect, it } from 'vitest'

import {
  SupervisorStreamDecoder,
  supervisorStreamEvent,
} from '../src/main/gascity/supervisor-stream'

function structuredPayload(operation: string): string {
  return JSON.stringify({
    format: 'structured',
    id: 'session-1',
    operation,
    provider: 'claude',
    schema_version: 'session.structured.v1',
    structured_messages: [],
    template: 'agent/worker',
    history: {},
  })
}

describe('gas city supervisor stream decoding', () => {
  it('dispatches one frame per blank-line-terminated block', () => {
    const decoder = new SupervisorStreamDecoder()
    const frames = decoder.push('event: activity\ndata: {"activity":"in-turn"}\n\n')
    expect(frames).toEqual([{ event: 'activity', data: '{"activity":"in-turn"}' }])
  })

  it('holds a partial line until the rest of it arrives', () => {
    const decoder = new SupervisorStreamDecoder()
    expect(decoder.push('event: activity\ndata: {"activ')).toEqual([])
    expect(decoder.push('ity":"idle"}\n\n')).toEqual([
      { event: 'activity', data: '{"activity":"idle"}' },
    ])
  })

  it('joins multi-line data and skips comment padding', () => {
    const decoder = new SupervisorStreamDecoder()
    const frames = decoder.push(': keep-alive\nevent: turn\ndata: one\ndata: two\n\n')
    expect(frames).toEqual([{ event: 'turn', data: 'one\ntwo' }])
  })

  it('accepts CRLF line endings', () => {
    const decoder = new SupervisorStreamDecoder()
    expect(decoder.push('event: heartbeat\r\ndata: {}\r\n\r\n')).toEqual([
      { event: 'heartbeat', data: '{}' },
    ])
  })

  it('carries the last event id as the resume cursor', () => {
    const decoder = new SupervisorStreamDecoder()
    decoder.push('id: cursor-1\nevent: heartbeat\ndata: {}\n\n')
    expect(decoder.cursor).toBe('cursor-1')
    const frames = decoder.push('event: heartbeat\ndata: {}\n\n')
    // A later block without an id keeps the cursor it inherited.
    expect(frames[0]?.lastEventId).toBe('cursor-1')
    decoder.push('id: cursor-2\ndata: {}\n\n')
    expect(decoder.cursor).toBe('cursor-2')
  })

  it('keeps the cursor across a reset so a resume does not lose position', () => {
    const decoder = new SupervisorStreamDecoder()
    decoder.push('id: cursor-9\nevent: heartbeat\ndata: {}\n\nevent: activity\ndata: {"a')
    decoder.reset()
    expect(decoder.cursor).toBe('cursor-9')
    expect(decoder.push('event: heartbeat\ndata: {}\n\n')).toHaveLength(1)
  })

  it('defaults an unnamed block to the message event', () => {
    const decoder = new SupervisorStreamDecoder()
    expect(decoder.push('data: {}\n\n')[0]?.event).toBe('message')
  })

  it('names every declared event', () => {
    const cases = [
      ['structured', structuredPayload('snapshot'), 'structured'],
      ['turn', JSON.stringify({ format: 'conversation', id: 's', turns: [] }), 'turn'],
      ['activity', JSON.stringify({ activity: 'idle' }), 'activity'],
      ['pending', JSON.stringify({ kind: 'approval', request_id: 'r1' }), 'pending'],
      ['pending_cleared', JSON.stringify({ request_id: 'r1' }), 'pending-cleared'],
      ['heartbeat', JSON.stringify({ timestamp: '2026-09-17T00:00:00Z' }), 'heartbeat'],
    ] as const
    for (const [event, data, kind] of cases)
      expect(supervisorStreamEvent({ event, data }).kind).toBe(kind)
  })

  it('reports a raw transcript frame as unrecognized instead of parsing it', () => {
    const event = supervisorStreamEvent({
      event: 'message',
      data: JSON.stringify({ format: 'raw', frames: [] }),
    })
    expect(event).toEqual({
      kind: 'unrecognized',
      event: 'message',
      reason: 'Event name is not declared by this build',
    })
  })

  it('reports an unusable payload without ending the stream', () => {
    expect(supervisorStreamEvent({ event: 'activity', data: 'not json' })).toEqual({
      kind: 'unrecognized',
      event: 'activity',
      reason: 'Payload is not JSON',
    })
    expect(supervisorStreamEvent({ event: 'activity', data: '[]' })).toEqual({
      kind: 'unrecognized',
      event: 'activity',
      reason: 'Payload is not an object',
    })
    expect(
      supervisorStreamEvent({ event: 'pending', data: '{"kind":"approval"}' }),
    ).toEqual({
      kind: 'unrecognized',
      event: 'pending',
      reason: 'Payload omits request_id',
    })
  })
})
