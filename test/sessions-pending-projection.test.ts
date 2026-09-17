import { describe, expect, it } from 'vitest'

import {
  MAX_SESSIONS_PENDING_OPTIONS,
  MAX_SESSIONS_PENDING_OPTION_TEXT,
  MAX_SESSIONS_SUBMIT_MESSAGE,
} from '../src/shared'
import type { PendingInteraction } from '../src/main/gascity/generated-supervisor-api'
import {
  projectSessionsPending,
  sessionsPendingAction,
  sessionsPendingRecord,
  sessionsSubmitMessage,
} from '../src/main/sessions/sessions-pending-projection'

describe('sessions pending projection', () => {
  it('holds the request identifier and the option words gc declared', () => {
    const record = sessionsPendingRecord(interaction(), 4)

    expect(record).toEqual({
      revision: 4,
      requestId: 'req-1',
      prompt: 'Run the migration?',
      options: ['allow', 'deny'],
    })
  })

  it('publishes positions to the renderer, and nothing else', () => {
    const record = sessionsPendingRecord(interaction(), 1)
    const projected = record === undefined ? undefined : projectSessionsPending(record)

    expect(projected).toEqual({
      revision: 1,
      prompt: 'Run the migration?',
      options: [
        { ordinal: 0, label: 'allow' },
        { ordinal: 1, label: 'deny' },
      ],
    })
    // The identifier gc addresses the interaction by does not appear in what
    // the renderer receives (ADR-046).
    expect(JSON.stringify(projected)).not.toContain('req-1')
  })

  it('refuses an interaction it would have no way to answer', () => {
    expect(sessionsPendingRecord(interaction({ request_id: '' }), 1)).toBeUndefined()
    expect(
      sessionsPendingRecord(
        interaction({ request_id: undefined as unknown as string }),
        1,
      ),
    ).toBeUndefined()
  })

  it('keeps an interaction that declared no options, for a typed answer', () => {
    const record = sessionsPendingRecord(
      interaction({ options: null, prompt: 'Which branch should this land on?' }),
      1,
    )

    expect(record).toMatchObject({
      prompt: 'Which branch should this land on?',
      options: [],
    })
  })

  it('drops an option a person could not read, and keeps the rest in order', () => {
    const record = sessionsPendingRecord(
      interaction({ options: ['allow', '', 'deny'] }),
      1,
    )

    expect(record?.options).toEqual(['allow', 'deny'])
  })

  it('stops at the option cap rather than rendering an unbounded list', () => {
    const many = Array.from(
      { length: MAX_SESSIONS_PENDING_OPTIONS + 6 },
      (_, index) => `option-${index}`,
    )
    const record = sessionsPendingRecord(interaction({ options: many }), 1)

    expect(record?.options).toHaveLength(MAX_SESSIONS_PENDING_OPTIONS)
    expect(record?.options[0]).toBe('option-0')
  })

  it('strips control bytes from the prompt and cuts a long label', () => {
    const record = sessionsPendingRecord(
      interaction({
        prompt: `${ESC}[31mForce push?${ESC}[0m`,
        options: ['y'.repeat(MAX_SESSIONS_PENDING_OPTION_TEXT + 20)],
      }),
      1,
    )
    const projected = record === undefined ? undefined : projectSessionsPending(record)

    expect(record?.prompt).toBe('Force push?')
    expect(projected?.options[0]?.label).toHaveLength(MAX_SESSIONS_PENDING_OPTION_TEXT)
  })

  it('has no prompt when the prompt was only control bytes', () => {
    const record = sessionsPendingRecord(interaction({ prompt: `${ESC}[2J` }), 1)

    expect(record?.prompt).toBeUndefined()
  })

  it('answers a position with the word that stands there', () => {
    const record = expected(sessionsPendingRecord(interaction(), 1))

    expect(sessionsPendingAction(record, 0)).toBe('allow')
    expect(sessionsPendingAction(record, 1)).toBe('deny')
  })

  it('refuses a position no option stands at', () => {
    const record = expected(sessionsPendingRecord(interaction(), 1))

    // Not resolved to a neighbour: an ordinal the renderer never received is
    // not an answer anyone chose.
    expect(sessionsPendingAction(record, 2)).toBeUndefined()
    expect(sessionsPendingAction(record, -1)).toBeUndefined()
    expect(sessionsPendingAction(record, 0.5)).toBeUndefined()
    expect(sessionsPendingAction(record, Number.NaN)).toBeUndefined()
  })

  it('sends what was typed, without the whitespace around it', () => {
    expect(sessionsSubmitMessage('  hold the release  ')).toBe('hold the release')
  })

  it('refuses a message with nothing in it', () => {
    expect(sessionsSubmitMessage('')).toBeUndefined()
    expect(sessionsSubmitMessage('     ')).toBeUndefined()
  })

  it('refuses a message over the cap rather than sending half of it', () => {
    expect(sessionsSubmitMessage('x'.repeat(MAX_SESSIONS_SUBMIT_MESSAGE))).toHaveLength(
      MAX_SESSIONS_SUBMIT_MESSAGE,
    )
    expect(
      sessionsSubmitMessage('x'.repeat(MAX_SESSIONS_SUBMIT_MESSAGE + 1)),
    ).toBeUndefined()
  })
})

const ESC = String.fromCharCode(27)

function interaction(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    kind: 'tool-approval',
    request_id: 'req-1',
    prompt: 'Run the migration?',
    options: ['allow', 'deny'],
    ...overrides,
  }
}

function expected<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a pending record')
  return value
}
