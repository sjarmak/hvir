/* global window */
/** Public-bridge client for this package's approved connectors. No host access beyond the bridge. */
window.host = (() => {
  const bridge = window.hvirExtension
  const prefix = `h${Math.random().toString(36).slice(2, 8)}`
  let serial = 0
  const pending = new Map()
  let stopped
  const dispose = (message) => {
    if (stopped) return
    stopped = Object.assign(new Error(message), { dispatch: 'not-sent' })
    for (const request of pending.values())
      request.reject(Object.assign(new Error(message), { dispatch: request.dispatch }))
    pending.clear()
    unsubscribe()
  }
  const unsubscribe = bridge.onMessage((message) => {
    if (message.kind === 'revoked') return dispose('Extension view was revoked')
    if (message.kind !== 'result') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) request.resolve(message.value)
    else request.reject(new Error(message.error))
  })
  window.addEventListener?.('pagehide', () => dispose('Extension view was disposed'), { once: true })
  /**
   * The bridge throws past 30 messages per second, and every output page is one message.
   * Keep a sliding window under that so large reads slow down instead of failing.
   */
  const MESSAGES_PER_SECOND = 25
  const sent = []

  async function paced() {
    for (;;) {
      if (stopped) throw stopped
      const now = Date.now()
      while (sent.length && now - sent[0] >= 1000) sent.shift()
      if (sent.length < MESSAGES_PER_SECOND) {
        sent.push(now)
        return
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000 - (now - sent[0])))
    }
  }

  function pastDeadline(dispatch) {
    const error = new Error('did not run: the refresh deadline passed')
    error.reason = 'deadline'
    error.dispatch = dispatch
    error.transient = true
    return error
  }

  async function request(capability, input, actionId, beforeSend, deadline = Infinity) {
    if (stopped) throw stopped
    const id = `${prefix}-${++serial}`
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, dispatch: 'not-sent' })
      paced().then(() => {
        if (stopped) throw stopped
        if (Date.now() >= deadline) throw pastDeadline('not-sent')
        beforeSend?.()
        pending.set(id, { resolve, reject, dispatch: 'unknown' })
        bridge.send({ kind: 'request', id, capability, ...(input ? { input } : {}), ...(actionId ? { actionId } : {}) })
      }).catch((error) => {
        pending.delete(id)
        reject(error)
      })
    })
  }

  async function readStream(receipt, stream, actionId, control) {
    let text = ''
    let offset = 0
    while (offset !== null) {
      if (control?.abandoned) throw pastDeadline('unknown')
      const page = await request('connector.output', { receipt, stream, offset }, actionId)
      text += page.data
      offset = page.nextOffset
    }
    return text
  }

  function parseLines(stdout) {
    return stdout
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line))
  }

  /** The JSON report gc and bd print on stdout for some failures (bd --readonly refusals), if any. */
  function failureReport(stdout) {
    const text = stdout.trim()
    const last = text.split('\n').at(-1)
    for (const candidate of [text, last]) {
      if (!candidate.startsWith('{')) continue
      try {
        return JSON.parse(candidate)
      } catch {
        // Not a single JSON document; try the last line next.
      }
    }
    return undefined
  }

  /** An Error carrying the report's message and `code` when present, else the first stderr line. */
  function failure(connector, exitCode, stdout, stderr) {
    const report = failureReport(stdout)
    const message = report?.error?.message ?? report?.error ?? report?.message
    const error = new Error(
      typeof message === 'string'
        ? message
        : stderr.trim().split('\n')[0] || `${connector} exited ${exitCode}`,
    )
    if (typeof report?.code === 'string') error.code = report.code
    error.exitCode = exitCode
    error.stderr = stderr
    return error
  }

  const IN_FLIGHT = 3
  const RETRIED_REASONS = new Set(['capacity', 'frequency'])
  const RETRY_BUDGET_MS = 45000
  const RETRY_BASE_MS = 200
  const RETRY_MAX_MS = 2000
  let inFlight = 0
  const waiting = []

  async function admitted(deadline = Infinity) {
    if (inFlight >= IN_FLIGHT) {
      await new Promise((resolve, reject) => {
        const start = () => {
          if (timer !== undefined) window.clearTimeout(timer)
          resolve()
        }
        const timer = Number.isFinite(deadline)
          ? window.setTimeout(() => {
            const at = waiting.indexOf(start)
            if (at >= 0) waiting.splice(at, 1)
            reject(pastDeadline('not-sent'))
          }, Math.max(0, deadline - Date.now()))
          : undefined
        waiting.push(start)
      })
    }
    inFlight += 1
  }

  function bounded(work, deadline, control) {
    if (!Number.isFinite(deadline)) return work
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        control.abandoned = true
        reject(pastDeadline('unknown'))
      }, Math.max(0, deadline - Date.now()))
      work.then(
        (value) => { window.clearTimeout(timer); resolve(value) },
        (error) => { window.clearTimeout(timer); reject(error) },
      )
    })
  }

  function released() {
    inFlight -= 1
    const next = waiting.shift()
    if (next) next()
  }

  function retryDelay(result, attempt) {
    return Number.isSafeInteger(result.retryAfterMs)
      ? result.retryAfterMs
      : Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
  }

  async function execute(input, actionId, beforeSend, callerDeadline = Infinity) {
    const deadline = Math.min(Date.now() + RETRY_BUDGET_MS, callerDeadline)
    for (let attempt = 0; ; attempt += 1) {
      const result = await request('connector.execute', input, actionId, beforeSend, callerDeadline)
      if (result.outcome === 'completed' || !RETRIED_REASONS.has(result.reason)) return result
      const delay = retryDelay(result, attempt)
      if (Date.now() + delay > deadline) return result
      await new Promise((resolve) => window.setTimeout(resolve, delay))
      if (Date.now() >= deadline) return result
    }
  }

  /**
   * Run an approved connector in the workspace root. Resolves parsed JSON (JSON lines when `lines`
   * is set, raw stdout when `text` is set, `{ exitCode, stdout, stderr }` when `exit` is set); rejects with the program's failure report, its first
   * stderr line, or the connector's reason.
   */
  async function run(connector, workspace, args, { lines = false, text = false, exit = false, actionId, beforeSend, deadline } = {}) {
    const limit = deadline ?? Infinity
    await admitted(limit)
    try {
      const control = { abandoned: false }
      return await bounded(runAdmitted(connector, workspace, args, { lines, text, exit, actionId, beforeSend, deadline: limit, control }), limit, control)
    } finally {
      released()
    }
  }

  const NOT_SENT_OUTCOMES = new Set(['not-started', 'unavailable'])

  async function readExit(result, actionId, control) {
    try {
      const stdout = await readStream(result.receipt, 'stdout', actionId, control)
      return { exitCode: result.code, stdout, stderr: await readStream(result.receipt, 'stderr', actionId, control) }
    } catch (cause) {
      const error = new Error(`output of a completed run could not be read: ${cause.message}`)
      error.dispatch = 'unknown'
      throw error
    }
  }

  async function runAdmitted(connector, workspace, args, { lines, text, exit, actionId, beforeSend, deadline, control }) {
    const result = await execute({
      connector,
      host: workspace.host,
      workspace: workspace.id,
      args,
    }, actionId, beforeSend, deadline)
    if (result.outcome !== 'completed') {
      const notSent = NOT_SENT_OUTCOMES.has(result.outcome)
      const error = new Error(
        `${connector} ${notSent ? 'did not run' : 'outcome unknown'}: ${result.reason ?? result.outcome}`,
      )
      error.reason = result.reason ?? result.outcome
      error.dispatch = notSent ? 'not-sent' : 'unknown'
      error.transient = error.reason === 'frequency' || error.reason === 'capacity'
      if (Number.isSafeInteger(result.retryAfterMs))
        error.retryAfterMs = result.retryAfterMs
      throw error
    }
    try {
      if (control?.abandoned) throw pastDeadline('unknown')
      if (exit) return await readExit(result, actionId, control)
      const stdout = await readStream(result.receipt, 'stdout', actionId, control)
      if (result.code !== 0)
        throw failure(connector, result.code, stdout, await readStream(result.receipt, 'stderr', actionId, control))
      if (result.truncated)
        throw new Error(`${connector} output exceeded the connector bound`)
      if (text) return stdout
      return lines ? parseLines(stdout) : JSON.parse(stdout)
    } finally {
      await request('connector.output', { receipt: result.receipt, release: true }, actionId).catch(
        () => {},
      )
    }
  }

  /**
   * connector.status answers for one workspace: each workspace connector's row reports whether it
   * is approved for that workspace's host (upstream ADR-074), and without a workspace those rows
   * are unavailable. Reuse each answer briefly so every run doesn't repeat it.
   */
  const STATUS_TTL_MS = 3000
  let statusCache = new Map()

  async function status(workspace) {
    const cached = statusCache.get(workspace.id)
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value
    const value = await request('connector.status', { workspace: workspace.id })
    statusCache = new Map(statusCache).set(workspace.id, { at: Date.now(), value })
    return value
  }

  /** Availability of each declared connector for `workspace`'s host: `supported` or hvir's reason. */
  async function availability({ workspace }) {
    const entries = await status(workspace)
    return Object.freeze(
      Object.fromEntries(entries.map((entry) => [entry.connector, entry.availability])),
    )
  }

  async function connect(connector) {
    const value = await request('connector.connect', { connector })
    statusCache = new Map()
    return value
  }

  const terminal = (connector, workspace, args, actionId) =>
    request('terminal.start', { connector, workspace: workspace.id, args }, actionId)

  return Object.freeze({ request, run, availability, connect, terminal })
})()
