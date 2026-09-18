/**
 * One page's lifecycle against the listener: pairing, one event stream at a
 * time, and the verbs the page may perform. The stream is reopened only when
 * a person asks (ADR-049 forbids a retry loop from a phone), and a 401 from
 * anywhere sends the page back to pairing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { SessionsMutationResponse, SessionsTerminalHandle } from '../../../shared'
import {
  CompanionUnauthorizedError,
  type CompanionClient,
  type CompanionEventStream,
} from './companion-client'
import {
  EMPTY_COMPANION_PAGE,
  applyCompanionSnapshot,
  applyCompanionTranscript,
  clearCompanionSelection,
  describeStreamEnd,
  selectCompanionRow,
  type CompanionConnection,
  type CompanionPageState,
} from './companion-store'

export interface CompanionSession {
  readonly connection: CompanionConnection
  readonly state: CompanionPageState
  /** The last verb the listener refused, until the next verb. */
  readonly notice?: string
  readonly pair: (code: string) => Promise<void>
  readonly reconnect: () => void
  readonly select: (handle: SessionsTerminalHandle) => Promise<void>
  readonly back: () => void
  readonly resume: () => Promise<void>
  readonly respond: (optionOrdinal: number) => Promise<void>
  /** Resolves true when the message was accepted, so the box can clear. */
  readonly submit: (message: string) => Promise<boolean>
}

const PAIRING_EXPIRED = 'The desktop no longer accepts this pairing; pair again'

export function useCompanionSession(client: CompanionClient): CompanionSession {
  const [connection, setConnection] = useState<CompanionConnection>(() =>
    client.paired() ? { phase: 'connecting' } : { phase: 'unpaired' },
  )
  const [state, setState] = useState(EMPTY_COMPANION_PAGE)
  const [notice, setNotice] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const stream = useRef<CompanionEventStream>(undefined)

  useEffect(() => {
    if (!client.paired()) return
    let active = true
    const opening = client.openEvents((event) => {
      if (!active) return
      setState((current) => {
        switch (event.type) {
          case 'snapshot':
            return applyCompanionSnapshot(current, event.snapshot)
          case 'transcript':
            return applyCompanionTranscript(current, event.transcript)
          case 'terminal':
            return current
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
  }, [client, attempt])

  const page = connection.phase === 'connected' ? connection.page : undefined

  const run = useCallback(
    async <T>(verb: (page: string) => Promise<T>): Promise<T | undefined> => {
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
          setNotice(describe(error))
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

  const select = useCallback(
    async (handle: SessionsTerminalHandle) => {
      const transcript = await run((current) => client.select(current, handle))
      if (transcript) setState((current) => selectCompanionRow(current, transcript))
    },
    [client, run],
  )

  const back = useCallback(() => {
    setNotice(undefined)
    setState(clearCompanionSelection)
  }, [])

  const selected = state.selected
  const pendingRevision = state.transcript?.pending?.revision

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
      reportRefusal(outcome, 'Answer', setNotice)
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
      reportRefusal(outcome, 'Message', setNotice)
      return outcome?.outcome === 'accepted'
    },
    [client, run, selected],
  )

  return {
    connection,
    state,
    notice,
    pair,
    reconnect,
    select,
    back,
    resume,
    respond,
    submit,
  }
}

function reportRefusal(
  outcome: SessionsMutationResponse | undefined,
  what: string,
  setNotice: (notice: string) => void,
): void {
  if (outcome?.outcome === 'unavailable') setNotice(`${what} refused: ${outcome.reason}`)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
