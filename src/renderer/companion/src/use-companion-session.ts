/**
 * One page's lifecycle against the listener: pairing, one event stream at a
 * time, and the verbs the page may perform. A lost stream is reopened when a
 * person asks, or once each time the page comes back into view: a phone that
 * was locked or switched away from loses its stream, and that one reopen is
 * never a retry loop. A page restored from history waits for a person
 * (ADR-972). A reopen keeps the open session and selects it again. A 401 from
 * anywhere sends the page back to pairing.
 *
 * A mirror (ADR-950) is selected optimistically: the row is marked selected
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
import { CompanionNavigationQueue } from './companion-navigation-queue'
import type { CompanionInputSource } from './companion-terminal-mount'
import {
  EMPTY_COMPANION_PAGE,
  applyCompanionSnapshot,
  applyCompanionTerminal,
  applyCompanionTranscript,
  beginCompanionSelection,
  clearCompanionSelection,
  describeStreamEnd,
  keepCompanionSelection,
  selectCompanionRow,
  type CompanionConnection,
  type CompanionPageState,
} from './companion-store'
import { useInputArming, type CompanionInputArmingControl } from './use-input-arming'

/**
 * Bytes for the mirrored row. The source defaults to the person typing; a
 * read-back gesture names itself, which is what frees it from the per-mirror
 * arm and keeps it out of the desktop's input record (ADR-955).
 */
export type CompanionInputVerb = (
  data: string,
  source?: CompanionInputSource,
) => Promise<void>

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
  readonly leave: () => void
  readonly select: (handle: SessionsTerminalHandle) => Promise<void>
  readonly back: () => void
  readonly resume: () => Promise<void>
  readonly respond: (optionOrdinal: number) => Promise<void>
  /** Resolves true when the message was accepted, so the box can clear. */
  readonly submit: (message: string) => Promise<boolean>
  /** Exact bytes for the mirrored row; typing is dropped here unless armed on a live mirror. */
  readonly input: CompanionInputVerb
  /**
   * The grid the page is drawing for the live mirror (ADR-958). Rejects when there is no
   * live mirror or the verb failed, which is the fit's signal to ask again.
   */
  readonly viewport: (cols: number, rows: number) => Promise<void>
}

const PAIRING_EXPIRED = 'The desktop no longer accepts this pairing; pair again'
const TYPING_OFF = 'Typing from the Companion is off in Settings'
const NAVIGATION_OFF =
  'Input from the Companion is off in Settings, so this program cannot be paged'
const MIRROR_ENDED = 'The mirrored terminal ended or changed'

export function useCompanionSession(client: CompanionClient): CompanionSession {
  const [connection, setConnection] = useState<CompanionConnection>(() =>
    client.paired() ? { phase: 'connecting' } : { phase: 'unpaired' },
  )
  const [state, setState] = useState(EMPTY_COMPANION_PAGE)
  const [notice, setNotice] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [feed] = useState(() => new CompanionMirrorFeed())
  const [navigationQueue] = useState(() => new CompanionNavigationQueue())
  const stream = useRef<CompanionEventStream>(undefined)
  const openingController = useRef<AbortController>(undefined)
  const lifecycle = useRef({ generation: 0, left: false })
  /** The row a reopen kept on screen, selected again once the new stream opens. */
  const reselect = useRef<SessionsTerminalHandle>(undefined)
  /** Armed when the page comes back into view; spent by the one reopen it allows. */
  const reopenOnReturn = useRef(false)
  const [shown, setShown] = useState(0)
  const mirrorHandle =
    state.terminal?.status === 'live' ? state.terminal.handle : undefined
  const arming = useInputArming(mirrorHandle)

  const leave = useCallback(() => {
    lifecycle.current = {
      generation: lifecycle.current.generation + 1,
      left: true,
    }
    stream.current?.close()
    stream.current = undefined
    openingController.current?.abort()
    openingController.current = undefined
    navigationQueue.clear()
    feed.clear()
    arming.disarm()
    setState(EMPTY_COMPANION_PAGE)
    setNotice(undefined)
    setConnection(
      client.paired()
        ? { phase: 'disconnected', detail: 'This page is suspended' }
        : { phase: 'unpaired' },
    )
  }, [client, feed, navigationQueue, arming])

  useEffect(() => {
    window.addEventListener('pagehide', leave)
    return () => window.removeEventListener('pagehide', leave)
  }, [leave])

  /** The listener no longer accepts the token: back to pairing, stream closed. */
  const expire = useCallback(() => {
    stream.current?.close()
    stream.current = undefined
    setState(EMPTY_COMPANION_PAGE)
    setConnection({ phase: 'unpaired', error: PAIRING_EXPIRED })
  }, [])

  useEffect(() => {
    if (!client.paired() || lifecycle.current.left) return
    let active = true
    const generation = lifecycle.current.generation
    const current = () =>
      active && !lifecycle.current.left && lifecycle.current.generation === generation
    const controller = new AbortController()
    openingController.current = controller
    feed.clear()
    const opening = client.openEvents((event) => {
      if (!current()) return
      if (event.type === 'terminal') feed.push(event.terminal)
      setState((page) => {
        switch (event.type) {
          case 'snapshot':
            return applyCompanionSnapshot(page, event.snapshot)
          case 'transcript':
            return applyCompanionTranscript(page, event.transcript)
          case 'terminal':
            return applyCompanionTerminal(page, event.terminal)
        }
      })
    }, controller.signal)
    opening.then(
      (opened) => {
        if (!current()) {
          opened.close()
          return
        }
        stream.current = opened
        setConnection({ phase: 'connected', page: opened.page })
        const kept = reselect.current
        reselect.current = undefined
        // The listener opens a fresh mirror on select, so the kept row is selected again.
        if (kept !== undefined) {
          client.select(opened.page, kept).then(
            (transcript) => {
              if (!current()) return
              setState((page) =>
                page.selected === kept ? selectCompanionRow(page, transcript) : page,
              )
            },
            (error: unknown) => {
              if (!current()) return
              if (error instanceof CompanionUnauthorizedError) {
                expire()
                return
              }
              setState((page) =>
                page.selected === kept ? clearCompanionSelection(page) : page,
              )
              setNotice(describe(error))
            },
          )
        }
        void opened.done.then((end) => {
          if (!current() || end.kind === 'aborted') return
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
        if (!current()) return
        setConnection(
          error instanceof CompanionUnauthorizedError
            ? { phase: 'unpaired', error: PAIRING_EXPIRED }
            : { phase: 'disconnected', detail: describe(error) },
        )
      },
    )
    return () => {
      active = false
      controller.abort()
      if (openingController.current === controller) openingController.current = undefined
      stream.current?.close()
      stream.current = undefined
    }
  }, [client, feed, attempt, expire])

  const page = connection.phase === 'connected' ? connection.page : undefined

  /** A verb the person asked for: its refusal replaces the notice, and nothing else does. */
  const run = useCallback(
    async <T>(
      verb: (page: string) => Promise<T>,
      refused: (failure: CompanionHttpFailure) => string = (failure) => failure.message,
    ): Promise<T | undefined> => {
      const generation = lifecycle.current.generation
      if (page === undefined || lifecycle.current.left) {
        setNotice('Not connected to the desktop')
        return undefined
      }
      setNotice(undefined)
      try {
        const result = await verb(page)
        return lifecycle.current.left || lifecycle.current.generation !== generation
          ? undefined
          : result
      } catch (error: unknown) {
        if (lifecycle.current.left || lifecycle.current.generation !== generation)
          return undefined
        if (error instanceof CompanionUnauthorizedError) {
          expire()
        } else {
          setNotice(
            error instanceof CompanionHttpFailure ? refused(error) : describe(error),
          )
        }
        return undefined
      }
    },
    [page, expire],
  )

  const pair = useCallback(
    async (code: string) => {
      const generation = lifecycle.current.generation
      lifecycle.current.left = false
      try {
        await client.pair(code)
      } catch (error: unknown) {
        if (lifecycle.current.left || lifecycle.current.generation !== generation) return
        setConnection({ phase: 'unpaired', error: describe(error) })
        return
      }
      if (lifecycle.current.left || lifecycle.current.generation !== generation) return
      setState(EMPTY_COMPANION_PAGE)
      setConnection({ phase: 'connecting' })
      setAttempt((count) => count + 1)
    },
    [client],
  )

  // The listener opens a fresh mirror on every select, so frames held from
  // before are stale: dropped first, so a view mounting between the old
  // lease's `ended` and the new `opened` never replays the old screen.
  const select = useCallback(
    async (handle: SessionsTerminalHandle) => {
      if (lifecycle.current.left) return
      const generation = lifecycle.current.generation
      feed.clear()
      setState((current) => beginCompanionSelection(current, handle))
      const transcript = await run((current) => client.select(current, handle))
      if (lifecycle.current.left || lifecycle.current.generation !== generation) return
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

  const reconnect = useCallback(() => {
    reopenOnReturn.current = false
    reselect.current = selected
    lifecycle.current = {
      generation: lifecycle.current.generation + 1,
      left: false,
    }
    disarm()
    setState(keepCompanionSelection)
    setNotice(undefined)
    setConnection({ phase: 'connecting' })
    setAttempt((count) => count + 1)
  }, [selected, disarm])

  // Leaving the kept row any way at all (Back, another row, pairing again)
  // cancels its reselect, so the desktop never opens a mirror nobody shows.
  useEffect(() => {
    if (reselect.current !== selected) reselect.current = undefined
  }, [selected])

  useEffect(() => {
    const changed = () => {
      reopenOnReturn.current = !document.hidden
      if (!document.hidden) setShown((count) => count + 1)
    }
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])

  useEffect(() => {
    if (
      connection.phase === 'disconnected' &&
      reopenOnReturn.current &&
      !lifecycle.current.left
    ) {
      reconnect()
    }
  }, [connection, shown, reconnect])

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

  /** One POST of bytes for the mirror; whether the desktop accepted them. */
  const send = useCallback(
    async (handle: SessionsTerminalHandle, data: string, navigation: boolean) => {
      const outcome = await run(
        (current) => client.input(current, handle, data, navigation),
        (failure) => {
          if (failure.status === 403) {
            if (navigation) return NAVIGATION_OFF
            disarm()
            return TYPING_OFF
          }
          return failure.status === 409 ? MIRROR_ENDED : failure.message
        },
      )
      reportRefusal(outcome, setNotice)
      return outcome?.outcome === 'accepted'
    },
    [client, run, disarm],
  )

  // Read-back navigation passes the arm on the way out and extends none of it:
  // a drag is not typing, so it neither waits for the person to arm the mirror
  // nor keeps an arming alive that would otherwise lapse (ADR-955). Its reports
  // travel in order, one request in flight per mirror and the rest joining the
  // next, so a program paged up and then down never hears the down first.
  const input = useCallback<CompanionInputVerb>(
    async (data, source = 'user') => {
      if (mirrorHandle === undefined || data === '') return
      if (source === 'navigation') {
        navigationQueue.push(mirrorHandle, data, (batch) =>
          send(mirrorHandle, batch, true),
        )
        return
      }
      if (!armed) return
      touch()
      await send(mirrorHandle, data, false)
    },
    [send, navigationQueue, armed, mirrorHandle, touch],
  )

  // The page holds the size on its own, so a failure here never touches the notice a verb
  // the person sent may be showing. A 409 means the mirror ended, which the stream's
  // `ended` frame says; anything else leaves the PTY at whatever size it has, which the
  // scaled view already draws. Either way the rejection tells the fit to ask again.
  const viewport = useCallback(
    async (cols: number, rows: number) => {
      const generation = lifecycle.current.generation
      if (
        page === undefined ||
        mirrorHandle === undefined ||
        lifecycle.current.left
      ) {
        throw new Error('No mirror is live')
      }
      try {
        await client.viewport(page, mirrorHandle, { cols, rows })
      } catch (error: unknown) {
        if (lifecycle.current.left || lifecycle.current.generation !== generation)
          return
        if (error instanceof CompanionUnauthorizedError) expire()
        throw error
      }
      if (lifecycle.current.left || lifecycle.current.generation !== generation) return
    },
    [client, page, mirrorHandle, expire],
  )

  return {
    connection,
    state,
    notice,
    feed,
    arming,
    pair,
    reconnect,
    leave,
    select,
    back,
    resume,
    respond,
    submit,
    input,
    viewport,
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
