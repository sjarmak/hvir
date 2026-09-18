// @vitest-environment happy-dom

import { act } from 'react'
import { describe, expect, it } from 'vitest'

import { COMPANION_TOKEN_STORAGE_KEY } from '../src/renderer/companion/src/companion-client'
import { COMPANION_KEYS } from '../src/renderer/companion/src/companion-keys'
import { row, snapshot, transcript } from './companion-page-fixture'
import {
  MIRROR_ROW,
  NOT_PROJECTED,
  armButton,
  button,
  click,
  emit,
  hide,
  host,
  openMirror,
  panes,
  render,
  renderPaired,
  rowHandles,
  server,
  settle,
  type,
  unmountPage,
  useCompanionPage,
} from './companion-page-harness'

useCompanionPage()

const READY_ROW = row({
  handle: 'ready-1',
  title: 'Fix the build',
  attention: { status: 'available', value: 'ready', observedAt: 5 },
})
const PROMPT_ROW = row({
  handle: 'prompt-1',
  title: 'Needs a decision',
  attention: { status: 'available', value: 'prompt', observedAt: 5 },
  promptBody: 'Claude needs your permission',
})
const STALE_ROW = row({
  handle: 'stale-1',
  title: 'Waiting on review',
  attention: { status: 'stale', value: 'ready', observedAt: 5, reason: 'source-stale' },
  freshness: 'stale',
  reason: 'closed',
})
const QUIET_ROW = row({
  handle: 'quiet-1',
  title: 'Quiet terminal',
  origin: { kind: 'hvir-terminal' },
  canAnswer: false,
})

describe('Companion page', () => {
  it('shows the pairing screen without a token and pairs with the code typed', async () => {
    await render()
    expect(host.querySelector('#companion-pair-code')).not.toBeNull()
    expect(server.calls).toHaveLength(0)

    await type('#companion-pair-code', ' ABCD-EFGH ')
    await click(button('Pair'))

    expect(server.calls[0]).toMatchObject({
      url: '/pair',
      method: 'POST',
      body: { code: 'ABCD-EFGH' },
    })
    expect(localStorage.getItem(COMPANION_TOKEN_STORAGE_KEY)).toBe('tok-1')
    expect(server.calls[1]).toMatchObject({
      url: '/api/events',
      authorization: 'Bearer tok-1',
    })
    await emit('snapshot', snapshot(1, [READY_ROW]))
    expect(rowHandles()).toEqual(['ready-1'])
  })

  it('says why a pairing code was refused and stays on the pairing screen', async () => {
    server.pairStatus = 401
    await render()
    await type('#companion-pair-code', 'WRONG')
    await click(button('Pair'))
    expect(host.querySelector('.companion-error')?.textContent).toContain(
      'Pairing code rejected',
    )
    expect(host.querySelector('#companion-pair-code')).not.toBeNull()
    expect(localStorage.getItem(COMPANION_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('renders rows in snapshot order with attention, unconfirmed reason, or nothing', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW, STALE_ROW, QUIET_ROW]))

    expect(rowHandles()).toEqual(['ready-1', 'stale-1', 'quiet-1'])
    const [ready, stale, quiet] = [...host.querySelectorAll('.companion-row')]
    expect(ready?.querySelector('.companion-badge-attention')?.textContent).toBe('ready')
    expect(ready?.querySelector('.companion-badge-stale')).toBeNull()
    expect(stale?.querySelector('.companion-badge-stale')?.textContent).toBe(
      'unconfirmed (closed)',
    )
    expect(quiet?.querySelectorAll('.companion-badge')).toHaveLength(0)
    expect(quiet?.textContent).toContain('Quiet terminal')
    expect(ready?.textContent).toContain('hvir / main')
  })

  it('shows a prompt row with its badge and the message under the title (ADR-051)', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [PROMPT_ROW, READY_ROW]))

    const [prompt, ready] = [...host.querySelectorAll('.companion-row')]
    const badge = prompt?.querySelector('.companion-badge-attention')
    expect(badge?.textContent).toBe('prompt')
    expect(badge?.classList.contains('companion-badge-prompt')).toBe(true)
    expect(prompt?.querySelector('.companion-row-prompt')?.textContent).toBe(
      'Prompt: Claude needs your permission',
    )
    expect(prompt?.textContent).toContain('Needs a decisionPrompt: Claude needs')
    expect(prompt?.querySelector('.companion-row-title')?.nextElementSibling).toBe(
      prompt?.querySelector('.companion-row-prompt'),
    )
    expect(ready?.querySelector('.companion-badge-attention')?.textContent).toBe('ready')
    expect(ready?.querySelector('.companion-row-prompt')).toBeNull()
  })

  it('shows one working badge, whether the desktop or the turn says so', async () => {
    const busyTerminal = row({
      handle: 'busy-1',
      title: 'Busy terminal',
      origin: { kind: 'hvir-terminal' },
      working: true,
      canAnswer: false,
    })
    const busyAgent = row({
      handle: 'busy-2',
      title: 'Busy agent',
      working: true,
      turn: { status: 'available', value: { state: 'working' } },
    })
    const waitingAgent = row({
      handle: 'waiting-1',
      title: 'Waiting agent',
      turn: { status: 'available', value: { state: 'waiting-for-user' } },
    })
    await renderPaired()
    await emit(
      'snapshot',
      snapshot(1, [busyTerminal, busyAgent, waitingAgent, QUIET_ROW]),
    )

    const badges = (index: number): string[] =>
      [
        ...(host
          .querySelectorAll('.companion-row')
          [index]?.querySelectorAll('.companion-badge') ?? []),
      ].map((badge) => badge.textContent ?? '')
    expect(badges(0)).toEqual(['working'])
    expect(badges(1)).toEqual(['working'])
    expect(badges(2)).toEqual(['waiting-for-user'])
    expect(badges(3)).toEqual([])
    expect(
      host
        .querySelector('.companion-badge-working')
        ?.classList.contains('companion-badge'),
    ).toBe(true)
  })

  it('ignores a snapshot revision older than the one it shows', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(2, [READY_ROW]))
    await emit('snapshot', snapshot(1, [QUIET_ROW]))
    expect(rowHandles()).toEqual(['ready-1'])

    await emit('snapshot', snapshot(3, [QUIET_ROW]))
    expect(rowHandles()).toEqual(['quiet-1'])
  })

  it('selects a row, answers its pending interaction and sends a trimmed message', async () => {
    server.transcriptReply = transcript({
      handle: 'ready-1',
      turns: [
        { ordinal: 1, role: 'user', kind: 'text', text: 'please fix the build' },
        { ordinal: 2, role: 'assistant', kind: 'text', text: 'Which branch?' },
      ],
      pending: {
        revision: 7,
        prompt: 'Which branch?',
        options: [
          { ordinal: 1, label: 'main' },
          { ordinal: 2, label: 'release' },
        ],
      },
    })
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))

    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/sessions/ready-1/select',
      body: { page: 'page-1' },
    })
    expect(host.querySelector('.companion-transcript')).not.toBeNull()
    expect(
      [...host.querySelectorAll('.companion-turn')].map((turn) => turn.textContent),
    ).toEqual(['userplease fix the build', 'assistantWhich branch?'])
    expect(host.querySelector('.companion-pending-prompt')?.textContent).toBe(
      'Which branch?',
    )

    await click(button('release'))
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/sessions/ready-1/respond',
      body: { page: 'page-1', handle: 'ready-1', pendingRevision: 7, optionOrdinal: 2 },
    })

    const before = server.calls.length
    await type('#companion-message', '   ')
    await click(button('Send'))
    expect(server.calls).toHaveLength(before)

    await type('#companion-message', '  ship it  ')
    await click(button('Send'))
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/sessions/ready-1/message',
      body: { page: 'page-1', handle: 'ready-1', message: 'ship it' },
    })
    expect(host.querySelector<HTMLTextAreaElement>('#companion-message')?.value).toBe('')
  })

  it('follows transcript events for the selected row and offers resume when lost', async () => {
    server.transcriptReply = transcript({ handle: 'ready-1', revision: 1 })
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)

    await emit('transcript', transcript({ handle: 'other', revision: 5, stream: 'lost' }))
    expect(host.querySelector('.companion-stream')).toBeNull()

    await emit(
      'transcript',
      transcript({
        handle: 'ready-1',
        revision: 2,
        stream: 'lost',
        streamReason: 'timeout',
      }),
    )
    expect(host.querySelector('.companion-stream span')?.textContent).toBe(
      'The transcript stream was lost. The Gas City supervisor did not answer in time.',
    )
    await click(button('Resume'))
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/sessions/ready-1/resume',
      body: { page: 'page-1' },
    })

    await click(button('Sessions'))
    expect(host.querySelector('.companion-transcript')).toBeNull()
    expect(rowHandles()).toEqual(['ready-1'])
  })

  it('shows a refused answer with its reason instead of retrying', async () => {
    server.transcriptReply = transcript({
      handle: 'ready-1',
      pending: { revision: 1, options: [{ ordinal: 1, label: 'yes' }] },
    })
    server.mutationReply = { outcome: 'unavailable', reason: 'stale-interaction' }
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)

    const before = server.calls.length
    await click(button('yes'))
    expect(server.calls).toHaveLength(before + 1)
    expect(host.querySelector('.companion-error')?.textContent).toBe(
      'That prompt changed before the answer was sent. Read the new one.',
    )
  })

  it('shows disconnected with a manual reconnect and never retries on its own', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))

    act(() => {
      server.drop()
    })
    await settle()
    await settle()

    expect(host.querySelector('.companion-connection')?.textContent).toContain(
      'Disconnected',
    )
    expect(server.streams()).toBe(1)

    await click(button('Reconnect'))
    expect(server.streams()).toBe(2)
    await emit('snapshot', snapshot(1, [QUIET_ROW]))
    expect(rowHandles()).toEqual(['quiet-1'])
    expect(host.querySelector('.companion-connection')).toBeNull()
  })

  it('returns to the pairing screen when the server revokes the pairing', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))

    await emit('closed', { reason: 'revoked' })

    expect(host.querySelector('#companion-pair-code')).not.toBeNull()
    expect(localStorage.getItem(COMPANION_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('forgets a token the server no longer accepts and asks to pair again', async () => {
    localStorage.setItem(COMPANION_TOKEN_STORAGE_KEY, 'stale-token')
    await render()

    expect(server.calls[0]).toMatchObject({
      url: '/api/events',
      authorization: 'Bearer stale-token',
    })
    expect(host.querySelector('#companion-pair-code')).not.toBeNull()
    expect(localStorage.getItem(COMPANION_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('closes the stream when the page unmounts', async () => {
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))
    unmountPage()
    expect(() => server.emit('snapshot', snapshot(2, []))).toThrow('no open event stream')
  })
})

describe('Companion page terminal mirror', () => {
  it('selecting a canMirror row mounts a pane at the desktop geometry and writes the tail then output', async () => {
    await openMirror('tail')
    expect(host.querySelector('.companion-terminal')).not.toBeNull()
    expect(host.querySelector('.companion-transcript')).toBeNull()
    expect(panes.panes).toHaveLength(1)
    const pane = panes.panes[0]!
    expect([pane.cols, pane.rows]).toEqual([132, 43])
    expect(pane.mounted?.closest('.companion-terminal-host')).not.toBeNull()
    expect(pane.writes).toEqual(['tail'])
    await emit('terminal', { type: 'output', handle: 'term-1', data: 'more' })
    expect(pane.writes).toEqual(['tail', 'more'])
    await emit('terminal', { type: 'output', handle: 'other', data: 'never' })
    expect(pane.writes).toEqual(['tail', 'more'])
  })

  it("shows the selected row's prompt message above the terminal while it lasts (ADR-051)", async () => {
    await openMirror()
    expect(host.querySelector('.companion-mirror-prompt')).toBeNull()

    const prompted = {
      ...MIRROR_ROW,
      attention: {
        status: 'available' as const,
        value: 'prompt' as const,
        observedAt: 5,
      },
      promptBody: 'Claude needs your permission',
    }
    await emit('snapshot', snapshot(2, [prompted]))
    const line = host.querySelector('.companion-mirror-prompt')
    expect(line?.textContent).toBe('Claude needs your permission')
    const header = host.querySelector('.companion-mirror-header')
    expect(line?.parentElement).toBe(header)
    expect(header?.lastElementChild).toBe(line)
    expect(
      header?.nextElementSibling?.classList.contains('companion-terminal-area'),
    ).toBe(true)
    expect(host.querySelector('.companion-terminal')).not.toBeNull()

    await emit('snapshot', snapshot(3, [MIRROR_ROW]))
    expect(host.querySelector('.companion-mirror-prompt')).toBeNull()
    expect(host.querySelector('.companion-terminal')).not.toBeNull()
  })

  it('an opened frame that lands before the select reply still writes the tail', async () => {
    server.transcriptReply = NOT_PROJECTED
    server.holdSelect = true
    await renderPaired()
    await emit('snapshot', snapshot(1, [MIRROR_ROW]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
    await emit('terminal', {
      type: 'opened',
      handle: 'term-1',
      cols: 80,
      rows: 24,
      tail: 'early',
    })
    await emit('terminal', { type: 'output', handle: 'term-1', data: '+' })
    expect(panes.panes[0]?.writes).toEqual(['early', '+'])
    await act(async () => {
      server.releaseSelect()
      await Promise.resolve()
    })
    await settle()
    expect(panes.panes).toHaveLength(1)
    expect(panes.panes[0]?.writes).toEqual(['early', '+'])
    expect(host.querySelector('.companion-terminal')).not.toBeNull()
  })

  it('geometry events resize the pane and the page never sends a resize', async () => {
    await openMirror()
    await emit('terminal', { type: 'geometry', handle: 'term-1', cols: 100, rows: 30 })
    expect(panes.panes[0]?.resizes).toEqual([{ cols: 100, rows: 30 }])
    expect(server.calls.some((call) => call.url.includes('resize'))).toBe(false)
    expect(
      server.calls.every((call) => call.method === 'GET' || !call.url.includes('cols')),
    ).toBe(true)
  })

  it('keys are dropped while disarmed and sent as exact bytes while armed', async () => {
    await openMirror()
    const pane = panes.panes[0]!
    expect(armButton().dataset['armed']).toBe('false')
    expect(armButton().getAttribute('aria-pressed')).toBe('false')
    expect(pane.inputEnabled.at(-1)).toBe(false)
    expect(host.querySelector('.companion-keys')).toBeNull()
    expect(host.querySelector('#companion-terminal-text')).toBeNull()
    await act(async () => {
      pane.emitData('\r')
      await Promise.resolve()
    })
    await settle()
    expect(server.inputs()).toEqual([])

    await click(armButton())
    expect(armButton().dataset['armed']).toBe('true')
    expect(armButton().getAttribute('aria-pressed')).toBe('true')
    expect(pane.inputEnabled.at(-1)).toBe(true)
    expect(
      [...host.querySelectorAll('.companion-keys .companion-key')].map((key) =>
        key.textContent?.trim(),
      ),
    ).toEqual(COMPANION_KEYS.map((key) => key.label))
    for (const key of COMPANION_KEYS) {
      await click(button(key.label))
      expect(server.calls.at(-1)).toMatchObject({
        url: '/api/sessions/term-1/input',
        method: 'POST',
        body: { page: 'page-1', data: key.data },
      })
    }
    expect(server.inputs()).toEqual(
      COMPANION_KEYS.map((key) => ({ page: 'page-1', data: key.data })),
    )

    await act(async () => {
      pane.emitData('x')
      await Promise.resolve()
    })
    await settle()
    expect(server.inputs().at(-1)).toEqual({ page: 'page-1', data: 'x' })

    await type('#companion-terminal-text', 'ls -la')
    await click(button('Send'))
    expect(server.inputs().at(-1)).toEqual({ page: 'page-1', data: 'ls -la' })
    expect(host.querySelector<HTMLInputElement>('#companion-terminal-text')?.value).toBe(
      '',
    )

    await type('#companion-terminal-text', 'y')
    await act(async () => {
      host
        .querySelector('form.companion-terminal-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await settle()
    expect(server.inputs().at(-1)).toEqual({ page: 'page-1', data: 'y\r' })

    await click(armButton())
    expect(armButton().dataset['armed']).toBe('false')
    expect(pane.inputEnabled.at(-1)).toBe(false)
    expect(host.querySelector('.companion-keys')).toBeNull()
    expect(host.querySelector('#companion-terminal-text')).toBeNull()
  })

  it('hiding the page disarms; pagehide disarms', async () => {
    await openMirror()
    await click(armButton())
    expect(armButton().dataset['armed']).toBe('true')
    await hide()
    expect(armButton().dataset['armed']).toBe('false')
    expect(panes.panes[0]?.inputEnabled.at(-1)).toBe(false)

    delete (document as unknown as { hidden?: unknown }).hidden
    await click(armButton())
    expect(armButton().dataset['armed']).toBe('true')
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })
    await settle()
    expect(armButton().dataset['armed']).toBe('false')
  })

  it('a terminal ended event disarms and shows the plain sentence', async () => {
    await openMirror()
    await click(armButton())
    await emit('terminal', { type: 'ended', handle: 'term-1', reason: 'exited' })
    expect(host.querySelector('.companion-mirror-ended')?.textContent).toBe(
      'The terminal ended.',
    )
    expect(host.textContent).not.toContain('exited')
    expect(armButton().dataset['armed']).toBe('false')
    expect(armButton().disabled).toBe(true)
    expect(host.querySelector('.companion-keys')).toBeNull()
    expect(host.querySelector('#companion-terminal-text')).toBeNull()
    expect(panes.panes[0]?.disposed).toBe(false)
  })

  it('a 403 on input disarms and names Settings; a 409 names the ended terminal', async () => {
    await openMirror()
    await click(armButton())
    server.inputStatus = 403
    server.inputError = 'server words'
    await click(button('Enter'))
    expect(host.querySelector('.companion-error')?.textContent).toBe(
      'Typing from the Companion is off in Settings',
    )
    expect(armButton().dataset['armed']).toBe('false')

    await click(armButton())
    server.inputStatus = 409
    await click(button('Enter'))
    expect(host.querySelector('.companion-error')?.textContent).toBe(
      'The mirrored terminal ended or changed',
    )
    expect(armButton().dataset['armed']).toBe('true')
  })

  it('unavailable transcripts show the desktop sentence and are hidden while a mirror is live', async () => {
    server.transcriptReply = transcript({
      handle: 'quiet-1',
      status: 'unavailable',
      reason: 'not-projected',
      stream: 'closed',
    })
    await renderPaired()
    await emit('snapshot', snapshot(1, [QUIET_ROW, MIRROR_ROW]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
    expect(host.querySelector('.companion-unavailable')?.textContent).toBe(
      'This session is no longer in the current Sessions view.',
    )
    expect(host.textContent).not.toContain('not-projected')
    await click(button('Sessions'))

    server.transcriptReply = NOT_PROJECTED
    await click(host.querySelectorAll<HTMLElement>('.companion-row')[1] as HTMLElement)
    await emit('terminal', {
      type: 'opened',
      handle: 'term-1',
      cols: 80,
      rows: 24,
      tail: '',
    })
    expect(host.querySelector('.companion-terminal')).not.toBeNull()
    expect(host.querySelector('.companion-unavailable')).toBeNull()
    expect(host.textContent).not.toContain('not-projected')
  })

  it('offers the transcript beside a mirror when the row takes answers', async () => {
    server.transcriptReply = transcript({
      handle: 'term-1',
      turns: [{ ordinal: 1, role: 'assistant', kind: 'text', text: 'hello from city' }],
    })
    await renderPaired()
    await emit('snapshot', snapshot(1, [{ ...MIRROR_ROW, canAnswer: true }]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
    await emit('terminal', {
      type: 'opened',
      handle: 'term-1',
      cols: 80,
      rows: 24,
      tail: '',
    })
    await click(button('Transcript'))
    expect(host.querySelector('.companion-transcript')).not.toBeNull()
    expect(host.textContent).toContain('hello from city')
    await click(button('Terminal'))
    expect(host.querySelector('.companion-terminal')).not.toBeNull()
    expect(panes.panes).toHaveLength(2)
    expect(panes.panes[0]?.disposed).toBe(true)
  })

  it('leaving the mirror disposes the pane and returning replays only the new lease', async () => {
    await openMirror('first')
    await emit('terminal', { type: 'output', handle: 'term-1', data: '-second' })
    await click(armButton())
    await click(button('Sessions'))
    expect(panes.panes[0]?.disposed).toBe(true)
    expect(host.querySelector('.companion-terminal')).toBeNull()
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
    // The listener ends the old lease and opens the new one back to back; when
    // the frames land in separate reads, no pane may show the old lease's tail.
    await emit('terminal', { type: 'ended', handle: 'term-1', reason: 'reselected' })
    expect(panes.panes).toHaveLength(1)
    await emit('terminal', {
      type: 'opened',
      handle: 'term-1',
      cols: 80,
      rows: 24,
      tail: 'again',
    })
    expect(panes.panes).toHaveLength(2)
    expect(panes.panes[1]?.writes).toEqual(['again'])
    expect(host.querySelector('.companion-mirror-ended')).toBeNull()
    expect(armButton().dataset['armed']).toBe('false')
    expect(panes.panes[1]?.inputEnabled).toEqual([false])
  })

  it('a second mirror opened after Back starts disarmed', async () => {
    server.transcriptReply = NOT_PROJECTED
    await renderPaired()
    const secondRow = row({ ...MIRROR_ROW, handle: 'term-2', title: 'second shell' })
    await emit('snapshot', snapshot(1, [MIRROR_ROW, secondRow]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
    await emit('terminal', {
      type: 'opened',
      handle: 'term-1',
      cols: 80,
      rows: 24,
      tail: '',
    })
    await click(armButton())
    expect(armButton().dataset['armed']).toBe('true')

    await click(button('Sessions'))
    server.transcriptReply = transcript({ ...NOT_PROJECTED, handle: 'term-2' })
    await click(host.querySelectorAll<HTMLElement>('.companion-row')[1] as HTMLElement)
    await emit('terminal', { type: 'ended', handle: 'term-1', reason: 'reselected' })
    await emit('terminal', {
      type: 'opened',
      handle: 'term-2',
      cols: 80,
      rows: 24,
      tail: '',
    })

    expect(armButton().dataset['armed']).toBe('false')
    expect(panes.panes).toHaveLength(2)
    expect(panes.panes[1]?.inputEnabled).toEqual([false])
    expect(host.querySelector('.companion-keys')).toBeNull()
    await act(async () => {
      panes.panes[1]?.emitData('\r')
      await Promise.resolve()
    })
    await settle()
    expect(server.inputs()).toEqual([])
  })

  it('a mirror opened after reconnect starts disarmed', async () => {
    await openMirror()
    await click(armButton())
    expect(armButton().dataset['armed']).toBe('true')
    act(() => {
      server.drop()
    })
    await settle()
    await settle()
    await click(button('Reconnect'))
    await emit('snapshot', snapshot(1, [MIRROR_ROW]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
    await emit('terminal', {
      type: 'opened',
      handle: 'term-1',
      cols: 80,
      rows: 24,
      tail: '',
    })

    expect(armButton().dataset['armed']).toBe('false')
    expect(panes.panes.at(-1)?.inputEnabled).toEqual([false])
  })

  it('shows a refused answer with the desktop sentence', async () => {
    server.transcriptReply = transcript({
      handle: 'ready-1',
      pending: { revision: 1, options: [{ ordinal: 1, label: 'yes' }] },
    })
    server.mutationReply = { outcome: 'unavailable', reason: 'no-interaction' }
    await renderPaired()
    await emit('snapshot', snapshot(1, [READY_ROW]))
    await click(host.querySelector<HTMLElement>('.companion-row') as HTMLElement)
    await click(button('yes'))
    expect(host.querySelector('.companion-error')?.textContent).toBe(
      'This session is not waiting on an answer.',
    )
  })
})
