/* global window */
;(() => {
  const ACTION = 'answer-decision'
  const CONNECTOR = 'hvir-answer'
  const BINDING = 'connector.action-binding'
  const UNBOUND_LINE = 'This hvir cannot bind answers to actions, so no answer was sent'
  const LINE_MAX = 400
  const ERROR_MAX = 240
  const UNKNOWN_LINE = 'Completion unknown; check the decision before answering again'

  const firstLine = (text) =>
    text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''

  const outcomeLine = ({ exitCode, stdout, stderr }) =>
    (firstLine(stdout) || firstLine(stderr) || `${CONNECTOR} exited ${exitCode}`).slice(0, LINE_MAX)

  let bound = false
  const unboundListeners = []
  window.hvirExtension?.onMessage((message) => {
    if (message.kind === 'hello') bound = Array.isArray(message.capabilities) && message.capabilities.includes(BINDING)
    else if (message.kind === 'revoked') bound = false
    else return
    if (!bound) unboundListeners.forEach((listener) => listener())
  })
  const actionBound = () => bound
  const onUnbound = (listener) => { unboundListeners.push(listener) }

  const requireBound = () => {
    if (!bound) throw Object.assign(new Error(UNBOUND_LINE), { dispatch: 'not-sent' })
  }

  async function record(host, workspace, input, actionId) {
    requireBound()
    const { decId, letter, cardSha256 } = input ?? {}
    if (!window.needsModel.validAnswer(decId, letter, cardSha256))
      throw new Error('The answer needs a decision id, one letter and the card hash')
    if (typeof actionId !== 'string' || actionId === '')
      throw new Error('An answer can only be recorded from an action')
    const result = await host.run(CONNECTOR, workspace, [decId, letter, cardSha256], { exit: true, actionId, beforeSend: requireBound })
    return { exitCode: result.exitCode, line: outcomeLine(result) }
  }

  const inFlight = new Set()
  const keyOf = (invocation) => {
    const { decId, cardSha256 } = invocation.input ?? {}
    return `${invocation.context?.workspace?.id}|${decId}|${cardSha256}`
  }

  const reply = (bridge, invocation, body) => bridge.send({ kind: 'action-result', id: invocation.id, ...body })

  const failedValue = (error) =>
    error.dispatch === 'not-sent'
      ? { exitCode: 2, notSent: true, line: String(error.message).slice(0, LINE_MAX) }
      : { unknown: true, line: UNKNOWN_LINE }

  async function handle(bridge, invocation) {
    const key = keyOf(invocation)
    if (inFlight.has(key)) {
      reply(bridge, invocation, { value: { unknown: true, line: UNKNOWN_LINE } })
      return
    }
    inFlight.add(key)
    try {
      if (!invocation.context?.workspace) throw new Error('This action needs a workspace')
      const value = await record(window.host, invocation.context.workspace, invocation.input, invocation.id)
      reply(bridge, invocation, { value })
    } catch (error) {
      if (error.dispatch) reply(bridge, invocation, { value: failedValue(error) })
      else reply(bridge, invocation, { error: String(error.message).slice(0, ERROR_MAX) })
    } finally {
      inFlight.delete(key)
    }
  }

  const listen = (bridge) =>
    bridge.onMessage((message) => {
      if (message.kind === 'action' && message.invocation?.action === ACTION) void handle(bridge, message.invocation)
    })

  const answerDecision = (decId, letter, cardSha256) =>
    window.host.request('actions.invoke', { action: ACTION, input: { decId, letter, cardSha256 } })

  const api = Object.freeze({ ACTION, CONNECTOR, UNKNOWN_LINE, actionBound, onUnbound, record, handle, listen, outcomeLine, answerDecision })
  window.answerAction = api
})()
