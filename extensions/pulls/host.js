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
    const slot = (await slotFor(connector, workspace, actionId)) ?? connector
    const result = await request(
      'connector.execute',
      { connector: slot, host: workspace.host, workspace: workspace.id, args },
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
   * hvir keeps one approval per (extension, connector) with a single host (upstream #991), so each
   * program is declared in host slots: `gc`, `gc-2`, `gc-3`, each approvable for a different host.
   * Callers name the base connector; a run uses the slot approved for the workspace's host.
   */
  const SLOTS = ['', '-2', '-3']
  const baseOf = (id) => id.replace(/-[23]$/, '')
  /** connector.status is one bridge message; reuse it briefly so every run doesn't repeat it. */
  const STATUS_TTL_MS = 3000
  let cachedStatus = { at: 0, value: [] }

  async function status(actionId) {
    if (Date.now() - cachedStatus.at < STATUS_TTL_MS) return cachedStatus.value
    cachedStatus = { at: Date.now(), value: await request('connector.status', undefined, actionId) }
    return cachedStatus.value
  }

  /** The slot of `base` approved for this workspace's host, if any. */
  async function slotFor(base, workspace, actionId) {
    const entries = await status(actionId)
    return entries.find(
      (entry) =>
        baseOf(entry.connector) === base && entry.availability === 'supported' && entry.host === workspace.host,
    )?.connector
  }

  /**
   * Availability by base connector. With `workspace`: `supported` when a slot is approved for its
   * host, `other-host` when slots are approved only elsewhere. `hosts` lists each base's approved
   * hosts and `freeSlot` the first unapproved slot, for telling the viewer what to approve.
   */
  async function availability({ actionId, workspace } = {}) {
    const entries = await status(actionId)
    const bases = [...new Set(entries.map((entry) => baseOf(entry.connector)))]
    const slots = (base) => entries.filter((entry) => baseOf(entry.connector) === base)
    const approved = (base) => slots(base).filter((entry) => entry.host)
    const state = (base) => {
      const supported = slots(base).filter((entry) => entry.availability === 'supported')
      if (supported.some((entry) => !workspace || entry.host === workspace.host)) return 'supported'
      if (supported.length) return 'other-host'
      return slots(base).find((entry) => entry.connector === base)?.availability ?? 'unavailable'
    }
    return Object.freeze({
      ...Object.fromEntries(bases.map((base) => [base, state(base)])),
      hosts: Object.fromEntries(bases.map((base) => [base, approved(base).map((entry) => entry.host)])),
      freeSlot: Object.fromEntries(
        bases.map((base) => [base, SLOTS.map((slot) => base + slot).find((id) => !approved(base).some((entry) => entry.connector === id))]),
      ),
    })
  }

  /**
   * Ask hvir to run an approved connector once in a new terminal at the workspace root. Only an
   * action handler can (`actionId` is required), and hvir asks the person to confirm first.
   * Resolves hvir's outcome: `handed-off`, `not-started` (including a declined confirmation), or
   * `interrupted-uncertain`.
   */
  async function terminal(connector, workspace, args, actionId) {
    const slot = await slotFor(connector, workspace, actionId)
    if (!slot) throw new Error(`${connector} is not approved for host ${workspace.host}`)
    return request('terminal.start', { connector: slot, workspace: workspace.id, args }, actionId)
  }

  return Object.freeze({ request, run, terminal, availability })
})()
