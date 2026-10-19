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

  async function request(capability, input) {
    await paced()
    const id = `${prefix}-${++serial}`
    return new Promise((resolve, reject) => {
      const unsubscribe = bridge.onMessage((message) => {
        if (message.kind !== 'result' || message.id !== id) return
        unsubscribe()
        if (message.ok) resolve(message.value)
        else reject(new Error(message.error))
      })
      bridge.send({ kind: 'request', id, capability, ...(input ? { input } : {}) })
    })
  }

  async function readStream(receipt, stream) {
    let text = ''
    let offset = 0
    while (offset !== null) {
      const page = await request('connector.output', { receipt, stream, offset })
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
      typeof message === 'string' ? message : stderr.trim().split('\n')[0] || `${connector} exited ${exitCode}`,
    )
    if (typeof report?.code === 'string') error.code = report.code
    return error
  }

  /**
   * Run an approved connector in the workspace root. Resolves parsed JSON (JSON lines when `lines`
   * is set, raw stdout when `text` is set); rejects with the program's failure report, its first
   * stderr line, or the connector's reason.
   */
  async function run(connector, workspace, args, { lines = false, text = false } = {}) {
    const result = await request('connector.execute', {
      connector,
      host: workspace.host,
      workspace: workspace.id,
      args,
    })
    if (result.outcome !== 'completed') {
      const error = new Error(`${connector} did not run: ${result.reason ?? result.outcome}`)
      error.reason = result.reason ?? result.outcome
      throw error
    }
    try {
      const [stdout, stderr] = await Promise.all([
        readStream(result.receipt, 'stdout'),
        readStream(result.receipt, 'stderr'),
      ])
      if (result.code !== 0) throw failure(connector, result.code, stdout, stderr)
      if (result.truncated) throw new Error(`${connector} output exceeded the connector bound`)
      if (text) return stdout
      return lines ? parseLines(stdout) : JSON.parse(stdout)
    } finally {
      await request('connector.output', { receipt: result.receipt, release: true }).catch(
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
    return Object.freeze(Object.fromEntries(entries.map((entry) => [entry.connector, entry.availability])))
  }

  return Object.freeze({ request, run, availability })
})()
