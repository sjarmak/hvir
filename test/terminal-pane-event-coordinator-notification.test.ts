import { describe, expect, it } from 'vitest'

import { TerminalPaneEventCoordinator } from '../src/renderer/src/terminal/terminal-pane-event-coordinator'
import type { TerminalEvent } from '../src/renderer/src/terminal/terminal-pane'
import { MAX_ACTIONABLE_BODY_CHARS } from '../src/shared'

const notification = (
  source: 'osc-9' | 'osc-777',
  body: string,
  title = '',
): TerminalEvent => ({ type: 'notification', source, title, body })

describe('TerminalPaneEventCoordinator bell and notification effects (ADR-051)', () => {
  it('keeps the BEL byte as the bell and never turns a notification into one', () => {
    const coordinator = new TerminalPaneEventCoordinator('fallback title')

    expect(coordinator.handle({ type: 'bell' })).toEqual({ bell: true })
    expect(
      coordinator.handle(notification('osc-9', 'Claude needs your permission')),
    ).not.toHaveProperty('bell')
  })

  it('yields a notification effect carrying the body from either source', () => {
    const coordinator = new TerminalPaneEventCoordinator('fallback title')

    expect(
      coordinator.handle(notification('osc-9', 'Claude needs your permission')),
    ).toEqual({ notification: { body: 'Claude needs your permission' } })
    expect(
      coordinator.handle(notification('osc-777', 'Review requested', 'Done')),
    ).toEqual({ notification: { body: 'Review requested' } })
  })

  it('bounds the body to one short line and drops an empty one', () => {
    const coordinator = new TerminalPaneEventCoordinator('fallback title')
    const long = `${'x'.repeat(MAX_ACTIONABLE_BODY_CHARS + 40)}\nsecond line`

    expect(coordinator.handle(notification('osc-9', long))).toEqual({
      notification: { body: 'x'.repeat(MAX_ACTIONABLE_BODY_CHARS) },
    })
    expect(coordinator.handle(notification('osc-9', 'first\r\nsecond'))).toEqual({
      notification: { body: 'first' },
    })
    expect(coordinator.handle(notification('osc-9', '  '))).toEqual({
      notification: {},
    })
  })
})
