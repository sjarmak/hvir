/* global window */
/** Public-bridge client for this package's approved connectors. No host access beyond the bridge. */
window.host = (() => {
  const bridge = window.hvirExtension
  const prefix = `h${Math.random().toString(36).slice(2, 8)}`
  let serial = 0
  /**
   * The bridge throws past 30 messages per second, and every output page is one message.
   * Keep a sliding window under that so large reads slow down instead of failing.
   */
  const MESSAGES_PER_SECOND = 25
  const sent = []

  async function paced() {
    for (;;) {
      const now = Date.now()
      while (sent.length && now - sent[0] >= 1000) sent.shift()
      if (sent.length < MESSAGES_PER_SECOND) {
        sent.push(now)
        return
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000 - (now - sent[0])))
    }
  }

  async function request(capability, input, actionId, beforeSend) {
    await paced()
    beforeSend?.()
    const id = `${prefix}-${++serial}`
    return new Promise((resolve, reject) => {
      const unsubscribe = bridge.onMessage((message) => {
        if (message.kind !== 'result' || message.id !== id) return
        unsubscribe()
        if (message.ok) resolve(message.value)
        else reject(new Error(message.error))
      })
      bridge.send({ kind: 'request', id, capability, ...(input ? { input } : {}), ...(actionId ? { actionId } : {}) })
    })
  }

  async function readStream(receipt, stream, actionId) {
    let text = ''
    let offset = 0
    while (offset !== null) {
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
    return error
  }

  const IN_FLIGHT = 3
  const RETRIED_REASONS = new Set(['capacity', 'frequency'])
  const RETRY_BUDGET_MS = 45000
  const RETRY_BASE_MS = 200
  const RETRY_MAX_MS = 2000
  let inFlight = 0
  const waiting = []

  async function admitted() {
    if (inFlight >= IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve))
    inFlight += 1
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

  async function execute(input, actionId, beforeSend) {
    const deadline = Date.now() + RETRY_BUDGET_MS
    for (let attempt = 0; ; attempt += 1) {
      const result = await request('connector.execute', input, actionId, beforeSend)
      if (result.outcome === 'completed' || !RETRIED_REASONS.has(result.reason)) return result
      const delay = retryDelay(result, attempt)
      if (Date.now() + delay > deadline) return result
      await new Promise((resolve) => window.setTimeout(resolve, delay))
    }
  }

  /**
   * Run an approved connector in the workspace root. Resolves parsed JSON (JSON lines when `lines`
   * is set, raw stdout when `text` is set, `{ exitCode, stdout, stderr }` when `exit` is set); rejects with the program's failure report, its first
   * stderr line, or the connector's reason.
   */
  async function run(connector, workspace, args, { lines = false, text = false, exit = false, actionId, beforeSend } = {}) {
    await admitted()
    try {
      return await runAdmitted(connector, workspace, args, { lines, text, exit, actionId, beforeSend })
    } finally {
      released()
    }
  }

  const NOT_SENT_OUTCOMES = new Set(['not-started', 'unavailable'])

  async function readExit(result, actionId) {
    try {
      const stdout = await readStream(result.receipt, 'stdout', actionId)
      return { exitCode: result.code, stdout, stderr: await readStream(result.receipt, 'stderr', actionId) }
    } catch (cause) {
      const error = new Error(`output of a completed run could not be read: ${cause.message}`)
      error.dispatch = 'unknown'
      throw error
    }
  }

  async function runAdmitted(connector, workspace, args, { lines, text, exit, actionId, beforeSend }) {
    const result = await execute({
      connector,
      host: workspace.host,
      workspace: workspace.id,
      args,
    }, actionId, beforeSend)
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
      if (exit) return await readExit(result, actionId)
      const stdout = await readStream(result.receipt, 'stdout', actionId)
      if (result.code !== 0)
        throw failure(connector, result.code, stdout, await readStream(result.receipt, 'stderr', actionId))
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
