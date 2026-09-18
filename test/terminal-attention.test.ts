import { describe, expect, it } from 'vitest'

import { asSessionsTerminalHandle } from '../src/shared'
import {
  actionableEntriesFingerprint,
  nextTerminalAttention,
  terminalActionableAttentionCount,
  terminalActionableEntries,
  terminalAttentionAfterSignal,
  terminalAttentionBadgeText,
  terminalAttentionDescription,
  terminalAttentionLabel,
  terminalIdleAttentionAfterInput,
  terminalInputArmsIdleAttention,
  terminalOutputAttentionDecision,
  terminalWorkingCount,
} from '../src/renderer/src/terminal/terminal-attention'

describe('terminal attention', () => {
  it('suppresses every signal while the terminal is focused', () => {
    expect(nextTerminalAttention(undefined, 'working', true)).toBeUndefined()
    expect(nextTerminalAttention(undefined, 'bell', true)).toBeUndefined()
    expect(nextTerminalAttention(undefined, 'idle', true)).toBeUndefined()
    expect(nextTerminalAttention('idle', 'bell', true)).toBeUndefined()
  })

  it('shows submitted-turn output as working before it becomes ready', () => {
    expect(nextTerminalAttention(undefined, 'working', false)).toBe('working')
    expect(nextTerminalAttention(undefined, 'bell', false)).toBe('bell')
    expect(nextTerminalAttention(undefined, 'idle', false)).toBe('idle')
    expect(nextTerminalAttention('working', 'idle', false)).toBe('idle')
  })

  it('keeps the highest-priority unseen signal', () => {
    expect(nextTerminalAttention('working', 'bell', false)).toBe('bell')
    expect(nextTerminalAttention('bell', 'working', false)).toBe('bell')
    expect(nextTerminalAttention('bell', 'idle', false)).toBe('idle')
    expect(nextTerminalAttention('idle', 'bell', false)).toBe('idle')
  })

  it('ranks a prompt above idle and bell, and only focus displaces it', () => {
    expect(nextTerminalAttention(undefined, 'prompt', false)).toBe('prompt')
    expect(nextTerminalAttention('idle', 'prompt', false)).toBe('prompt')
    expect(nextTerminalAttention('bell', 'prompt', false)).toBe('prompt')
    expect(nextTerminalAttention('working', 'prompt', false)).toBe('prompt')
    expect(nextTerminalAttention('prompt', 'idle', false)).toBe('prompt')
    expect(nextTerminalAttention('prompt', 'bell', false)).toBe('prompt')
    expect(nextTerminalAttention('prompt', 'working', false)).toBe('prompt')
    expect(nextTerminalAttention('prompt', 'prompt', false)).toBe('prompt')
    expect(nextTerminalAttention('idle', 'prompt', true)).toBeUndefined()
  })

  it('carries the latest notification body with a prompt and none with anything else', () => {
    const raised = terminalAttentionAfterSignal({}, 'prompt', 'Claude needs your permission', false)
    expect(raised).toEqual({ attention: 'prompt', promptBody: 'Claude needs your permission' })

    // A later notification replaces the body; a lower signal leaves it alone.
    expect(terminalAttentionAfterSignal(raised, 'prompt', 'Claude is waiting', false)).toEqual(
      { attention: 'prompt', promptBody: 'Claude is waiting' },
    )
    expect(terminalAttentionAfterSignal(raised, 'bell', undefined, false)).toEqual(raised)
    expect(terminalAttentionAfterSignal(raised, 'idle', undefined, false)).toEqual(raised)
    expect(terminalAttentionAfterSignal(raised, 'prompt', undefined, false)).toEqual({
      attention: 'prompt',
    })
    expect(terminalAttentionAfterSignal({ attention: 'idle' }, 'bell', undefined, false)).toEqual(
      { attention: 'idle' },
    )
    expect(terminalAttentionAfterSignal(raised, 'prompt', 'again', true)).toEqual({})
  })

  it('labels signals without relying on color and counts only actionable terminals', () => {
    expect(terminalAttentionLabel('working')).toBe('Working')
    expect(terminalAttentionLabel('bell')).toBe('Bell')
    expect(terminalAttentionLabel('idle')).toBe('Ready')
    expect(terminalAttentionLabel('prompt')).toBe('Prompt')
    expect(terminalAttentionBadgeText('working')).toBe('working')
    expect(terminalAttentionBadgeText('bell')).toBe('bell')
    expect(terminalAttentionBadgeText('idle')).toBe('ready')
    expect(terminalAttentionBadgeText('prompt')).toBe('prompt')
    expect(
      terminalActionableAttentionCount(['working', 'bell', 'idle', 'prompt', undefined]),
    ).toBe(3)
    expect(terminalWorkingCount(['working', 'bell', 'working', undefined])).toBe(2)
  })

  it('describes a prompt with its message and every other signal by its label', () => {
    expect(terminalAttentionDescription('prompt', 'Claude needs your permission')).toBe(
      'Prompt: Claude needs your permission',
    )
    expect(terminalAttentionDescription('prompt', undefined)).toBe('Prompt')
    expect(terminalAttentionDescription('idle', 'Claude needs your permission')).toBe(
      'Ready',
    )
    expect(terminalAttentionDescription('bell', undefined)).toBe('Bell')
  })

  it('lists the actionable terminals as fresh entries, in session order', () => {
    expect(
      terminalActionableEntries([
        { id: 'terminal-1', attention: 'working' },
        { id: 'terminal-2', attention: 'bell' },
        { id: 'terminal-3' },
        { id: 'terminal-4', attention: 'idle' },
        { id: 'terminal-5', attention: 'prompt', promptBody: 'Claude needs your permission' },
        { id: 'terminal-6', attention: 'prompt' },
      ]),
    ).toEqual([
      {
        handle: asSessionsTerminalHandle('terminal-2'),
        kind: 'bell',
        freshness: 'fresh',
      },
      {
        handle: asSessionsTerminalHandle('terminal-4'),
        kind: 'ready',
        freshness: 'fresh',
      },
      {
        handle: asSessionsTerminalHandle('terminal-5'),
        kind: 'prompt',
        freshness: 'fresh',
        body: 'Claude needs your permission',
      },
      {
        handle: asSessionsTerminalHandle('terminal-6'),
        kind: 'prompt',
        freshness: 'fresh',
      },
    ])
  })

  it('fingerprints the body with the kind, and is not fooled by separators in it', () => {
    const prompt = (body: string) =>
      terminalActionableEntries([{ id: 'terminal-1', attention: 'prompt', promptBody: body }])
    expect(actionableEntriesFingerprint(prompt('first'))).not.toBe(
      actionableEntriesFingerprint(prompt('second')),
    )
    expect(
      actionableEntriesFingerprint(
        terminalActionableEntries([
          { id: 'a', attention: 'prompt', promptBody: 'x' },
          { id: 'b', attention: 'idle' },
        ]),
      ),
    ).not.toBe(
      actionableEntriesFingerprint(
        terminalActionableEntries([{ id: 'a', attention: 'prompt', promptBody: 'x|b:ready' }]),
      ),
    )
  })

  it('arms idle-after-burst only at a submitted terminal-input boundary', () => {
    expect(terminalInputArmsIdleAttention('hello')).toBe(false)
    expect(terminalInputArmsIdleAttention('\u001b[A')).toBe(false)
    expect(terminalInputArmsIdleAttention('\r')).toBe(true)
    expect(terminalInputArmsIdleAttention('prompt\n')).toBe(true)
  })

  it('ignores startup output and raises Ready only once per submitted turn', () => {
    let state = terminalIdleAttentionAfterInput('initial', 'typing')
    expect(state).toBe('initial')
    expect(terminalOutputAttentionDecision(state)).toEqual({
      notify: false,
      scheduleIdle: false,
    })

    state = terminalIdleAttentionAfterInput(state, '\r')
    expect(terminalOutputAttentionDecision(state)).toEqual({
      notify: true,
      scheduleIdle: true,
    })

    state = 'settled'
    expect(terminalOutputAttentionDecision(state)).toEqual({
      notify: true,
      scheduleIdle: false,
    })
    expect(terminalIdleAttentionAfterInput(state, '\n')).toBe('armed')
  })
})
