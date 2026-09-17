import { describe, expect, it } from 'vitest'

import {
  MAX_SESSIONS_TRANSCRIPT_TEXT,
  MAX_SESSIONS_TRANSCRIPT_TURNS,
} from '../src/shared'
import type { SessionStreamStructuredMessageEvent } from '../src/main/gascity/generated-supervisor-api'
import type {
  SessionStructuredBlock,
  SessionStructuredMessage,
  SessionTranscriptStructuredResponse,
} from '../src/main/gascity/generated-supervisor-transcript'
import {
  emptySessionsTranscriptFold,
  foldSessionsTranscriptEvent,
  foldSessionsTranscriptSnapshot,
  sessionsTranscriptTurns,
} from '../src/main/sessions/sessions-transcript-projection'

describe('sessions transcript projection', () => {
  it('folds a claude worker snapshot into typed turns', () => {
    const fold = foldSessionsTranscriptSnapshot(
      snapshot([
        message('m1', 'user', [{ type: 'text', text: 'ship the panel' }]),
        message('m2', 'assistant', [
          { type: 'thinking', thinking: 'weighing the options' },
          { type: 'text', text: 'Reading the source.' },
          { type: 'tool_use', name: 'Read', file_path: '/src/index.ts' },
        ]),
        message('m3', 'tool', [
          { type: 'tool_result', name: 'Read', content: 'export const x = 1' },
        ]),
      ]),
    )

    expect(sessionsTranscriptTurns(fold)).toEqual([
      { ordinal: 0, role: 'user', kind: 'text', text: 'ship the panel' },
      { ordinal: 1, role: 'assistant', kind: 'text', text: 'Reading the source.' },
      {
        ordinal: 2,
        role: 'assistant',
        kind: 'tool-use',
        text: '/src/index.ts',
        toolName: 'Read',
      },
      {
        ordinal: 3,
        role: 'tool',
        kind: 'tool-result',
        text: 'export const x = 1',
        toolName: 'Read',
      },
    ])
    expect(fold.cursor).toBe('resume-1')
    expect(fold.older).toBe(false)
  })

  it('folds a codex worker snapshot the same way, whatever the provider says', () => {
    // The provider name is the supervisor's; the fold is provider-neutral, so a
    // codex transcript produces the same vocabulary as a claude one.
    const fold = foldSessionsTranscriptSnapshot({
      ...snapshot([
        message('c1', 'user', [{ type: 'text', text: 'run the gate' }]),
        message('c2', 'assistant', [{ type: 'text', text: 'Gate is green.' }]),
        message('c3', 'system', [], { message: 'session resumed' }),
      ]),
      provider: 'codex',
    })

    expect(sessionsTranscriptTurns(fold).map((turn) => [turn.role, turn.kind])).toEqual([
      ['user', 'text'],
      ['assistant', 'text'],
      ['system', 'event'],
    ])
  })

  it('strips control bytes for display and marks a turn cut to the cap', () => {
    const fold = foldSessionsTranscriptSnapshot(
      snapshot([
        message('m1', 'assistant', [
          { type: 'text', text: '\u001b[31mred\u001b[0m\u0007 text\r\nnext' },
          { type: 'text', text: 'x'.repeat(MAX_SESSIONS_TRANSCRIPT_TEXT + 40) },
        ]),
      ]),
    )
    const turns = sessionsTranscriptTurns(fold)

    expect(turns[0]?.text).toBe('red text\nnext')
    expect(turns[0]?.truncated).toBeUndefined()
    expect(turns[1]?.text).toHaveLength(MAX_SESSIONS_TRANSCRIPT_TEXT)
    expect(turns[1]?.truncated).toBe(true)
  })

  it('drops a block whose only content is control bytes', () => {
    const fold = foldSessionsTranscriptSnapshot(
      snapshot([
        message('m1', 'assistant', [
          { type: 'text', text: '\u001b[2J\u001b[H' },
          { type: 'text', text: 'after' },
        ]),
      ]),
    )

    expect(sessionsTranscriptTurns(fold)).toHaveLength(1)
  })

  it('keeps a tool result that failed, and says so', () => {
    const fold = foldSessionsTranscriptSnapshot(
      snapshot([
        message('m1', 'tool', [
          { type: 'tool_result', name: 'Bash', content: 'exit 1', is_error: true },
        ]),
      ]),
    )

    expect(sessionsTranscriptTurns(fold)[0]).toMatchObject({
      kind: 'tool-result',
      toolName: 'Bash',
      failed: true,
    })
  })

  it('appends an upsert and replaces the message it names', () => {
    const first = foldSessionsTranscriptEvent(
      emptySessionsTranscriptFold(),
      event('upsert', [
        message(
          'm1',
          'assistant',
          [{ type: 'text', text: 'Read' }],
          undefined,
          'partial',
        ),
      ]),
    )
    const grown = foldSessionsTranscriptEvent(
      first,
      event('upsert', [
        message('m1', 'assistant', [{ type: 'text', text: 'Read the file.' }]),
        message('m2', 'user', [{ type: 'text', text: 'thanks' }]),
      ]),
    )

    expect(sessionsTranscriptTurns(first)[0]).toMatchObject({
      text: 'Read',
      partial: true,
    })
    expect(sessionsTranscriptTurns(grown)).toEqual([
      { ordinal: 0, role: 'assistant', kind: 'text', text: 'Read the file.' },
      { ordinal: 1, role: 'user', kind: 'text', text: 'thanks' },
    ])
  })

  it('withdraws a superseded message instead of keeping both', () => {
    const held = foldSessionsTranscriptEvent(
      emptySessionsTranscriptFold(),
      event('upsert', [
        message('m1', 'assistant', [{ type: 'text', text: 'first attempt' }]),
        message('m2', 'assistant', [{ type: 'text', text: 'second attempt' }]),
      ]),
    )
    const after = foldSessionsTranscriptEvent(
      held,
      event('upsert', [
        message(
          'm1',
          'assistant',
          [{ type: 'text', text: 'first attempt' }],
          undefined,
          'superseded',
        ),
      ]),
    )

    expect(sessionsTranscriptTurns(after).map((turn) => turn.text)).toEqual([
      'second attempt',
    ])
  })

  it('replaces the transcript on a reset, and carries the new cursor', () => {
    const held = foldSessionsTranscriptEvent(
      emptySessionsTranscriptFold(),
      event('upsert', [message('m1', 'user', [{ type: 'text', text: 'stale' }])]),
    )
    const after = foldSessionsTranscriptEvent(held, {
      ...event(
        'reset',
        [message('m9', 'user', [{ type: 'text', text: 'rewritten' }])],
        'resume-9',
      ),
      reset_reason: 'history_rewritten',
    })

    expect(sessionsTranscriptTurns(after).map((turn) => turn.text)).toEqual(['rewritten'])
    expect(after.cursor).toBe('resume-9')
  })

  it('holds the newest turns at the cap and counts what left the head', () => {
    const many = Array.from({ length: MAX_SESSIONS_TRANSCRIPT_TURNS + 12 }, (_, index) =>
      message(`m${index}`, 'user', [{ type: 'text', text: `turn ${index}` }]),
    )
    const fold = foldSessionsTranscriptSnapshot(snapshot(many))
    const turns = sessionsTranscriptTurns(fold)

    expect(turns).toHaveLength(MAX_SESSIONS_TRANSCRIPT_TURNS)
    expect(fold.dropped).toBe(12)
    expect(fold.older).toBe(true)
    // The ordinal is the turn's position in the whole transcript, so the pane
    // can say what it is showing rather than renumbering from zero.
    expect(turns[0]).toMatchObject({ ordinal: 12, text: 'turn 12' })
  })

  it('reports the older turns the supervisor still holds', () => {
    const fold = foldSessionsTranscriptSnapshot({
      ...snapshot([message('m1', 'user', [{ type: 'text', text: 'recent' }])]),
      pagination: {
        has_older_messages: true,
        returned_message_count: 1,
        total_compactions: 0,
        total_message_count: 400,
      },
    })

    expect(fold.older).toBe(true)
    expect(fold.dropped).toBe(0)
  })
})

function snapshot(
  messages: readonly SessionStructuredMessage[],
  resume = 'resume-1',
): SessionTranscriptStructuredResponse {
  return {
    format: 'structured',
    history: history(resume),
    id: 'worker-1',
    operation: 'snapshot',
    provider: 'claude',
    schema_version: 'session.structured.v1',
    structured_messages: messages,
    template: 'structured',
  }
}

function event(
  operation: SessionStreamStructuredMessageEvent['operation'],
  messages: readonly SessionStructuredMessage[],
  resume = 'resume-1',
): SessionStreamStructuredMessageEvent {
  return {
    format: 'structured',
    history: history(resume),
    id: 'worker-1',
    operation,
    provider: 'claude',
    schema_version: 'session.structured.v1',
    structured_messages: messages,
    template: 'structured',
  }
}

function history(resume: string) {
  return {
    continuity: { status: 'continuous' },
    cursor: { resume_token: resume },
    generation: { id: 'gen-1' },
    tail_state: { activity: 'idle' },
    transcript_stream_id: 'stream-1',
  }
}

function message(
  id: string,
  role: SessionStructuredMessage['role'],
  blocks: readonly SessionStructuredBlock[],
  systemEvent?: { readonly message: string },
  status: SessionStructuredMessage['status'] = 'final',
): SessionStructuredMessage {
  return {
    id,
    role,
    blocks,
    status,
    ...(systemEvent === undefined ? {} : { system_event: systemEvent }),
  }
}
