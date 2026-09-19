/**
 * The Companion's /api rows (ADR-049, ADR-050, ADR-052), bound onto the
 * server's router: one event stream per page, the page's rows on demand, the
 * four Sessions verbs, terminal input, and the mirror's resize. Bodies are
 * validated with the shared guards before any port is asked; a page the
 * service does not hold is 404, a transcript verb before a selection is 409,
 * typing while Settings forbids it is 403, input or resize for a row without a
 * mirror or after the mirror ended is 409, a resize the Away door refuses is
 * 409 with `{outcome: "refused", reason}` so the page can tell it from an
 * ended mirror, and every other shape mismatch is 400. Mirror output rides
 * the page stream as `terminal` frames; a stream that cannot drain them ends
 * the mirror instead of buffering without bound.
 */
import {
  asSessionsTerminalHandle,
  isCompanionInputRequest,
  isCompanionResizeRequest,
  isCompanionRespondRequest,
  isCompanionSubmitRequest,
  type CompanionEvent,
  type CompanionResizeResponse,
  type CompanionTerminalEvent,
  type SessionsMutationResponse,
  type SessionsTerminalHandle,
} from '../../shared'
import {
  CompanionHttpError,
  SSE_MAX_BACKLOG_BYTES,
  json,
  readJsonBody,
  type SseWriter,
} from './companion-http'
import {
  CompanionMirrorEndedError,
  CompanionResizeRefusedError,
} from './companion-page-mirror'
import type { CompanionRequestContext, CompanionRouter } from './companion-router'
import {
  CompanionNoMirrorError,
  CompanionNoSelectionError,
  CompanionPageNotOpenError,
  CompanionTypingDisallowedError,
  type CompanionSessionsService,
} from './companion-sessions'

export const COMPANION_PAGE_HEADER = 'x-companion-page'

type Handler = (context: CompanionRequestContext) => Promise<void> | void

export function bindCompanionApi(
  router: CompanionRouter,
  sessions: CompanionSessionsService,
): void {
  const bind = (method: 'GET' | 'POST', pattern: string, handler: Handler): void =>
    router.register(method, pattern, (context) => translate(() => handler(context)))
  bind('GET', '/api/events', (context) => streamEvents(context, sessions))
  bind('GET', '/api/sessions', (context) => {
    const page = context.url.searchParams.get('page')
    if (page === null || page === '')
      throw new CompanionHttpError(400, 'Expected ?page=<id>')
    json(context.response, 200, sessions.snapshot(page))
  })
  bind('POST', '/api/sessions/:handle/select', async (context) => {
    const page = await pageBody(context)
    json(context.response, 200, sessions.select(page, handleParam(context)))
  })
  bind('POST', '/api/sessions/:handle/resume', async (context) => {
    const page = await pageBody(context)
    handleParam(context)
    json(context.response, 200, sessions.resume(page))
  })
  bind('POST', '/api/sessions/:handle/respond', (context) => respond(context, sessions))
  bind('POST', '/api/sessions/:handle/message', (context) => message(context, sessions))
  bind('POST', '/api/sessions/:handle/input', (context) => input(context, sessions))
  bind('POST', '/api/sessions/:handle/resize', (context) => resize(context, sessions))
}

async function respond(
  context: CompanionRequestContext,
  sessions: CompanionSessionsService,
): Promise<void> {
  const { page, rest } = await verbBody(context)
  if (!isCompanionRespondRequest(rest) || rest.handle !== handleParam(context)) {
    throw new CompanionHttpError(
      400,
      'Expected {"page", "handle", "pendingRevision", "optionOrdinal", "text"?}',
    )
  }
  json(context.response, 200, await sessions.respond(page, rest))
}

async function message(
  context: CompanionRequestContext,
  sessions: CompanionSessionsService,
): Promise<void> {
  const { page, rest } = await verbBody(context)
  if (!isCompanionSubmitRequest(rest) || rest.handle !== handleParam(context)) {
    throw new CompanionHttpError(400, 'Expected {"page", "handle", "message"}')
  }
  const text = rest.message.trim()
  if (text.length === 0) throw new CompanionHttpError(400, 'Message is empty')
  json(context.response, 200, await sessions.submit(page, { ...rest, message: text }))
}

async function input(
  context: CompanionRequestContext,
  sessions: CompanionSessionsService,
): Promise<void> {
  const { page, rest } = await verbBody(context)
  if (!isCompanionInputRequest(rest)) {
    throw new CompanionHttpError(
      400,
      'Expected {"page", "data"}, with "navigation" only on a read-back page key',
    )
  }
  sessions.input(
    page,
    handleParam(context),
    rest.data,
    rest.navigation === true ? 'navigation' : 'typing',
  )
  const accepted: SessionsMutationResponse = { outcome: 'accepted' }
  json(context.response, 200, accepted)
}

/** The Away door's refusal is answered here with its reason; the rest translate as input does. */
async function resize(
  context: CompanionRequestContext,
  sessions: CompanionSessionsService,
): Promise<void> {
  const { page, rest } = await verbBody(context)
  if (!isCompanionResizeRequest(rest)) {
    throw new CompanionHttpError(400, 'Expected {"page", "cols", "rows"}')
  }
  let reply: CompanionResizeResponse = { outcome: 'accepted' }
  try {
    sessions.resize(page, handleParam(context), rest.cols, rest.rows)
  } catch (error) {
    if (!(error instanceof CompanionResizeRefusedError)) throw error
    reply = { outcome: 'refused', reason: error.reason }
  }
  json(context.response, reply.outcome === 'accepted' ? 200 : 409, reply)
}

async function translate(run: () => Promise<void> | void): Promise<void> {
  try {
    await run()
  } catch (error) {
    if (error instanceof CompanionPageNotOpenError) {
      throw new CompanionHttpError(404, error.message)
    }
    if (error instanceof CompanionTypingDisallowedError) {
      throw new CompanionHttpError(403, error.message)
    }
    if (
      error instanceof CompanionNoSelectionError ||
      error instanceof CompanionNoMirrorError ||
      error instanceof CompanionMirrorEndedError
    ) {
      throw new CompanionHttpError(409, error.message)
    }
    throw error
  }
}

function streamEvents(
  context: CompanionRequestContext,
  sessions: CompanionSessionsService,
): void {
  const page = sessions.openPage()
  const stream = context.openEventStream({ [COMPANION_PAGE_HEADER]: page.pageId })
  stream.send('snapshot', page.snapshot)
  const stop = page.events((event: CompanionEvent) => {
    switch (event.type) {
      case 'snapshot':
        stream.send('snapshot', event.snapshot)
        return
      case 'transcript':
        stream.send('transcript', event.transcript)
        return
      case 'terminal':
        sendTerminal(stream, event.terminal, () =>
          sessions.endMirror(page.pageId, 'overrun'),
        )
        return
      case 'closed':
        stream.send('closed', { reason: event.reason })
        stream.close()
        return
      default:
        unreachable(event)
    }
  })
  stream.onClose(() => {
    void stop()
    sessions.closePage(page.pageId)
  })
}

/**
 * Output past the backlog cap is dropped and the mirror ended: the `ended`
 * frame that follows is small, and the page reselects when it catches up.
 */
function sendTerminal(
  stream: SseWriter,
  terminal: CompanionTerminalEvent,
  overrun: () => void,
): void {
  if (terminal.type === 'output' && stream.backlog > SSE_MAX_BACKLOG_BYTES) {
    overrun()
    return
  }
  stream.send('terminal', terminal)
}

function unreachable(event: never): never {
  throw new Error(`Unhandled Companion event ${JSON.stringify(event)}`)
}

function handleParam(context: CompanionRequestContext): SessionsTerminalHandle {
  const handle = context.params['handle']
  if (handle === undefined || handle.length === 0) {
    throw new CompanionHttpError(400, 'Expected a session handle')
  }
  return asSessionsTerminalHandle(handle)
}

async function pageBody(context: CompanionRequestContext): Promise<string> {
  const body = await readJsonBody(context.request)
  if (!isRecord(body) || Object.keys(body).length !== 1) {
    throw new CompanionHttpError(400, 'Expected {"page": string}')
  }
  return pageOf(body)
}

async function verbBody(
  context: CompanionRequestContext,
): Promise<{ readonly page: string; readonly rest: Record<string, unknown> }> {
  const body = await readJsonBody(context.request)
  if (!isRecord(body)) throw new CompanionHttpError(400, 'Expected a JSON object')
  const { page: _page, ...rest } = body
  return { page: pageOf(body), rest }
}

function pageOf(body: Record<string, unknown>): string {
  const page = body['page']
  if (typeof page !== 'string' || page.length === 0) {
    throw new CompanionHttpError(400, 'Expected "page" to name an open page')
  }
  return page
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
