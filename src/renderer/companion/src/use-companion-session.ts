/**
 * One page's lifecycle against the listener: pairing, one event stream at a
 * time, and the verbs the page may perform. The stream is reopened only when
 * a person asks (ADR-049 forbids a retry loop from a phone), and a 401 from
 * anywhere sends the page back to pairing.
 *
 * A mirror (ADR-050) is selected optimistically: the row is marked selected
 * before the listener answers, so the `opened` frame that can arrive on the
 * event stream ahead of the select reply is kept rather than dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  sessionsMutationUnavailableMessage,
  type SessionsMutationResponse,
  type SessionsTerminalHandle,
} from '../../../shared'
import {
  CompanionHttpFailure,
  CompanionUnauthorizedError,
  type CompanionClient,
  type CompanionEventStream,
} from './companion-client'
import { CompanionMirrorFeed } from './companion-mirror-feed'
import {
  EMPTY_COMPANION_PAGE,
  applyCompanionSnapshot,
  applyCompanionTerminal,
  applyCompanionTranscript,
  beginCompanionSelection,
  clearCompanionSelection,
  describeStreamEnd,
  selectCompanionRow,
  type CompanionConnection,
  type CompanionPageState,
} from './companion-store'
import { useInputArming, type CompanionInputArmingControl } from './use-input-arming'

export interface CompanionSession {
  readonly connection: CompanionConnection
  readonly state: CompanionPageState
  /** The last verb the listener refused, until the next verb. */
  readonly notice?: string
  /** The mirror frames the page holds; the terminal view attaches to it. */
  readonly feed: CompanionMirrorFeed
  readonly arming: CompanionInputArmingControl
  readonly pair: (code: string) => Promise<void>
  readonly reconnect: () => void
  readonly select: (handle: SessionsTerminalHandle) => Promise<void>
  readonly back: () => void
  readonly resume: () => Promise<void>
  readonly respond: (optionOrdinal: number) => Promise<void>
  /** Resolves true when the message was accepted, so the box can clear. */
  readonly submit: (message: string) => Promise<boolean>
  /** Exact bytes for the mirrored row; dropped here unless armed on a live mirror. */
  readonly input: (data: string) => Promise<void>
}

const PAIRING_EXPIRED = 'The desktop no longer accepts this pairing; pair again'
const TYPING_OFF = 'Typing from the Companion is off in Settings'
const MIRROR_ENDED = 'The mirrored terminal ended or changed'

export function useCompanionSession(client: CompanionClient): CompanionSession {
  const [connection, setConnection] = useState<CompanionConnection>(() =>
    client.paired() ? { phase: 'connecting' } : { phase: 'unpaired' },
  )
  const [state, setState] = useState(EMPTY_COMPANION_PAGE)
  const [notice, setNotice] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [feed] = useState(() => new CompanionMirrorFeed())
  const stream = useRef<CompanionEventStream>(undefined)
  const mirrorHandle =
    state.terminal?.status === 'live' ? state.terminal.handle : undefined
  const arming = useInputArming(mirrorHandle)

  useEffect(() => {
    if (!client.paired()) return
    let active = true
    feed.clear()
    const opening = client.openEvents((event) => {
      if (!active) return
      if (event.type === 'terminal') feed.push(event.terminal)
      setState((current) => {
        switch (event.type) {
          case 'snapshot':
            return applyCompanionSnapshot(current, event.snapshot)
          case 'transcript':
            return applyCompanionTranscript(current, event.transcript)
          case 'terminal':
            return applyCompanionTerminal(current, event.terminal)
        }
      })
    })
    opening.then(
      (opened) => {
        if (!active) {
          opened.close()
          return
        }
        stream.current = opened
        setConnection({ phase: 'connected', page: opened.page })
        void opened.done.then((end) => {
          if (!active || end.kind === 'aborted') return
          stream.current = undefined
          if (end.kind === 'closed' && end.reason === 'revoked') {
            client.forget()
            setConnection({
              phase: 'unpaired',
              error: 'The desktop revoked this pairing',
            })
          } else {
            setConnection({ phase: 'disconnected', detail: describeStreamEnd(end) })
          }
        })
      },
      (error: unknown) => {
        if (!active) return
        setConnection(
          error instanceof CompanionUnauthorizedError
            ? { phase: 'unpaired', error: PAIRING_EXPIRED }
            : { phase: 'disconnected', detail: describe(error) },
        )
      },
    )
    return () => {
      active = false
      stream.current?.close()
      stream.current = undefined
    }
  }, [client, feed, attempt])

  const page = connection.phase === 'connected' ? connection.page : undefined

  const run = useCallback(
    async <T>(
      verb: (page: string) => Promise<T>,
      refused: (failure: CompanionHttpFailure) => string = (failure) => failure.message,
    ): Promise<T | undefined> => {
      if (page === undefined) {
        setNotice('Not connected to the desktop')
        return undefined
      }
      setNotice(undefined)
      try {
        return await verb(page)
      } catch (error: unknown) {
        if (error instanceof CompanionUnauthorizedError) {
          stream.current?.close()
          stream.current = undefined
          setState(EMPTY_COMPANION_PAGE)
          setConnection({ phase: 'unpaired', error: PAIRING_EXPIRED })
        } else {
          setNotice(
            error instanceof CompanionHttpFailure ? refused(error) : describe(error),
          )
        }
        return undefined
      }
    },
    [page],
  )

  const pair = useCallback(
    async (code: string) => {
      try {
        await client.pair(code)
      } catch (error: unknown) {
        setConnection({ phase: 'unpaired', error: describe(error) })
        return
      }
      setState(EMPTY_COMPANION_PAGE)
      setConnection({ phase: 'connecting' })
      setAttempt((count) => count + 1)
    },
    [client],
  )

  const reconnect = useCallback(() => {
    setState(EMPTY_COMPANION_PAGE)
    setNotice(undefined)
    setConnection({ phase: 'connecting' })
    setAttempt((count) => count + 1)
  }, [])

  // The listener opens a fresh mirror on every select, so frames held from
  // before are stale: dropped first, so a view mounting between the old
  // lease's `ended` and the new `opened` never replays the old screen.
  const select = useCallback(
    async (handle: SessionsTerminalHandle) => {
      feed.clear()
      setState((current) => beginCompanionSelection(current, handle))
      const transcript = await run((current) => client.select(current, handle))
      setState((current) =>
        transcript
          ? selectCompanionRow(current, transcript)
          : clearCompanionSelection(current),
      )
    },
    [client, feed, run],
  )

  const back = useCallback(() => {
    setNotice(undefined)
    setState(clearCompanionSelection)
  }, [])

  const selected = state.selected
  const pendingRevision = state.transcript?.pending?.revision
  const { armed, touch, disarm } = arming

  const resume = useCallback(async () => {
    if (selected === undefined) return
    const transcript = await run((current) => client.resume(current, selected))
    if (transcript) setState((current) => selectCompanionRow(current, transcript))
  }, [client, run, selected])

  const respond = useCallback(
    async (optionOrdinal: number) => {
      if (selected === undefined || pendingRevision === undefined) return
      const outcome = await run((current) =>
        client.respond(current, { handle: selected, pendingRevision, optionOrdinal }),
      )
      reportRefusal(outcome, setNotice)
    },
    [client, run, selected, pendingRevision],
  )

  const submit = useCallback(
    async (message: string) => {
      const trimmed = message.trim()
      if (selected === undefined || trimmed === '') return false
      const outcome = await run((current) =>
        client.submit(current, { handle: selected, message: trimmed }),
      )
      reportRefusal(outcome, setNotice)
      return outcome?.outcome === 'accepted'
    },
    [client, run, selected],
  )

  const input = useCallback(
    async (data: string) => {
      if (!armed || mirrorHandle === undefined || data === '') return
      touch()
      const outcome = await run(
        (current) => client.input(current, mirrorHandle, data),
        (failure) => {
          if (failure.status === 403) {
            disarm()
            return TYPING_OFF
          }
          return failure.status === 409 ? MIRROR_ENDED : failure.message
        },
      )
      reportRefusal(outcome, setNotice)
    },
    [client, run, armed, mirrorHandle, touch, disarm],
  )

  return {
    connection,
    state,
    notice,
    feed,
    arming,
    pair,
    reconnect,
    select,
    back,
    resume,
    respond,
    submit,
    input,
  }
}

function reportRefusal(
  outcome: SessionsMutationResponse | undefined,
  setNotice: (notice: string) => void,
): void {
  if (outcome?.outcome === 'unavailable') {
    setNotice(sessionsMutationUnavailableMessage(outcome.reason))
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
