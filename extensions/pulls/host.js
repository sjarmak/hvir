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

  /** `actionId` admits a request from a view hvir opened hidden to run an agent action. */
  async function request(capability, input, actionId) {
    await paced()
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

  /**
   * Run an approved connector in the workspace root. Resolves parsed JSON (JSON lines when `lines`
   * is set, raw stdout when `text` is set); rejects with the program's last stderr line or the
   * connector's reason.
   */
  async function run(connector, workspace, args, { lines = false, text = false, actionId } = {}) {
    const result = await request(
      'connector.execute',
      { connector, host: workspace.host, workspace: workspace.id, args },
      actionId,
    )
    if (result.outcome !== 'completed') {
      const error = new Error(`${connector} did not run: ${result.reason ?? result.outcome}`)
      error.reason = result.reason ?? result.outcome
      throw error
    }
    try {
      const [stdout, stderr] = await Promise.all([
        readStream(result.receipt, 'stdout', actionId),
        readStream(result.receipt, 'stderr', actionId),
      ])
      if (result.code !== 0)
        throw new Error(stderr.trim().split('\n').at(-1) || `${connector} exited ${result.code}`)
      if (result.truncated) throw new Error(`${connector} output exceeded the connector bound`)
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

  async function status(workspace, actionId) {
    const cached = statusCache.get(workspace.id)
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value
    const value = await request('connector.status', { workspace: workspace.id }, actionId)
    statusCache = new Map(statusCache).set(workspace.id, { at: Date.now(), value })
    return value
  }

  /** Availability of each declared connector for `workspace`'s host: `supported` or hvir's reason. */
  async function availability({ actionId, workspace }) {
    const entries = await status(workspace, actionId)
    return Object.freeze(Object.fromEntries(entries.map((entry) => [entry.connector, entry.availability])))
  }

  /**
   * Ask hvir to run an approved connector once in a new terminal at the workspace root. Only an
   * action handler can (`actionId` is required), and hvir asks the person to confirm first.
   * Resolves hvir's outcome: `handed-off`, `not-started` (including a declined confirmation), or
   * `interrupted-uncertain`.
   */
  async function terminal(connector, workspace, args, actionId) {
    return request('terminal.start', { connector, workspace: workspace.id, args }, actionId)
  }

  return Object.freeze({ request, run, terminal, availability })
})()
