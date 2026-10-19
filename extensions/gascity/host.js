/* global window */
/** Public-bridge client for this package's approved connectors. No host access beyond the bridge. */
window.host = (() => {
  const bridge = window.hvirExtension
  const prefix = `h${Math.random().toString(36).slice(2, 8)}`
  let serial = 0
  /**
   * The bridge throws past 30 messages per second, and every 8 KiB output page is one message.
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
   * Run an approved connector in the workspace root. Resolves parsed JSON (or JSON lines when
   * `lines` is set); rejects with the program's first stderr line or the connector's reason.
   */
  async function run(connector, workspace, args, { lines = false } = {}) {
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
      return lines ? parseLines(stdout) : JSON.parse(stdout)
    } finally {
      await request('connector.output', { receipt: result.receipt, release: true }).catch(
        () => {},
      )
    }
  }

  /**
   * Connector availability by id. hvir reports an approval as `supported` whatever workspace asks,
   * but runs it only for workspaces on the approved host; with `workspace`, an approval for another
   * host reads `other-host` and `hosts` names where each connector is approved.
   */
  async function availability({ workspace } = {}) {
    const status = await request('connector.status')
    const state = (entry) =>
      workspace && entry.availability === 'supported' && entry.host && entry.host !== workspace.host
        ? 'other-host'
        : entry.availability
    return Object.freeze({
      ...Object.fromEntries(status.map((entry) => [entry.connector, state(entry)])),
      hosts: Object.fromEntries(status.filter((entry) => entry.host).map((entry) => [entry.connector, entry.host])),
    })
  }

  return Object.freeze({ request, run, availability })
})()
