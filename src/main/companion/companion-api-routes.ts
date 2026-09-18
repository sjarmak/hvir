/**
 * The Companion's /api rows (ADR-049), bound onto the server's router: one
 * event stream per page, the page's rows on demand, and the four Sessions
 * verbs. Bodies are validated with the shared guards before any port is
 * asked; a page the service does not hold is 404, a transcript verb before a
 * selection is 409, and every other shape mismatch is 400.
 */
import {
  asSessionsTerminalHandle,
  isCompanionRespondRequest,
  isCompanionSubmitRequest,
  type CompanionEvent,
  type SessionsTerminalHandle,
} from '../../shared'
import { CompanionHttpError, json, readJsonBody } from './companion-http'
import type { CompanionRequestContext, CompanionRouter } from './companion-router'
import {
  CompanionNoSelectionError,
  CompanionPageNotOpenError,
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

async function translate(run: () => Promise<void> | void): Promise<void> {
  try {
    await run()
  } catch (error) {
    if (error instanceof CompanionPageNotOpenError) {
      throw new CompanionHttpError(404, error.message)
    }
    if (error instanceof CompanionNoSelectionError) {
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
    if (event.type === 'snapshot') stream.send('snapshot', event.snapshot)
    else if (event.type === 'transcript') stream.send('transcript', event.transcript)
    else {
      stream.send('closed', { reason: event.reason })
      stream.close()
    }
  })
  stream.onClose(() => {
    void stop()
    sessions.closePage(page.pageId)
  })
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
