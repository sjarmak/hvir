/* global window */
;(() => {
  const ACTION = 'answer-decision'
  const CONNECTOR = 'hvir-answer'
  const LINE_MAX = 400

  const firstLine = (text) =>
    text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''

  const outcomeLine = ({ exitCode, stdout, stderr }) =>
    (firstLine(stdout) || firstLine(stderr) || `${CONNECTOR} exited ${exitCode}`).slice(0, LINE_MAX)

  async function record(host, workspace, input, actionId) {
    const { decId, letter, cardSha256 } = input ?? {}
    if (!window.needsModel.validAnswer(decId, letter, cardSha256))
      throw new Error('The answer needs a decision id, one letter and the card hash')
    if (typeof actionId !== 'string' || actionId === '')
      throw new Error('An answer can only be recorded from an action')
    const result = await host.run(CONNECTOR, workspace, [decId, letter, cardSha256], { exit: true, actionId })
    return { exitCode: result.exitCode, line: outcomeLine(result) }
  }

  async function handle(bridge, invocation) {
    try {
      if (!invocation.context?.workspace) throw new Error('This action needs a workspace')
      const value = await record(window.host, invocation.context.workspace, invocation.input, invocation.id)
      bridge.send({ kind: 'action-result', id: invocation.id, value })
    } catch (error) {
      bridge.send({ kind: 'action-result', id: invocation.id, error: String(error.message).slice(0, 500) })
    }
  }

  const listen = (bridge) =>
    bridge.onMessage((message) => {
      if (message.kind === 'action' && message.invocation?.action === ACTION) void handle(bridge, message.invocation)
    })

  const answerDecision = (decId, letter, cardSha256) =>
    window.host.request('actions.invoke', { action: ACTION, input: { decId, letter, cardSha256 } })

  const api = Object.freeze({ ACTION, CONNECTOR, record, handle, listen, outcomeLine, answerDecision })
  window.answerAction = api
})()
