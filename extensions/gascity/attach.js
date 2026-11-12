/* global window */
;(() => {
  const ACTION = 'attach-session'
  const SEAT_ACTION = 'attach-seat'
  const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  const ERROR_MAX = 240

  const outcomeLine = (result, name) => {
    if (result?.outcome === 'handed-off') return `Opened a terminal attached to ${name}.`
    if (result?.outcome === 'not-started') return `Terminal not started: ${result.reason}`
    if (result?.outcome === 'interrupted-uncertain')
      return `The terminal may have started (${result.reason}). Check it before trying again.`
    return `Unexpected terminal result: ${JSON.stringify(result).slice(0, 120)}`
  }

  async function attach(host, workspace, input, actionId) {
    const name = input?.name
    if (typeof name !== 'string' || !NAME.test(name))
      throw new Error('name must be a session name')
    const result = await host.terminal(
      'gc',
      workspace,
      ['session', 'attach', name],
      actionId,
    )
    return { line: outcomeLine(result, name) }
  }

  async function handle(bridge, invocation) {
    try {
      if (!invocation.context?.workspace) throw new Error('This action needs a workspace')
      const value = await attach(
        window.host,
        invocation.context.workspace,
        invocation.input,
        invocation.id,
      )
      bridge.send({ kind: 'action-result', id: invocation.id, value })
    } catch (error) {
      bridge.send({
        kind: 'action-result',
        id: invocation.id,
        error: String(error.message).slice(0, ERROR_MAX),
      })
    }
  }

  const listen = (bridge, action = ACTION) =>
    bridge.onMessage((message) => {
      if (message.kind === 'action' && message.invocation?.action === action)
        void handle(bridge, message.invocation)
    })

  const invoke = (name, action = ACTION) =>
    window.host.request('actions.invoke', { action, input: { name } })

  const attachSeat = async (name) => {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error('name must be a session name')
    return invoke(name, SEAT_ACTION)
  }

  const routeRow = (row, open, onAttach) => {
    if (row.dataset.attach) return invoke(row.dataset.attach).then(onAttach)
    return open(row)
  }

  window.attachAction = Object.freeze({
    ACTION,
    SEAT_ACTION,
    NAME,
    attach,
    handle,
    listen,
    invoke,
    attachSeat,
    routeRow,
  })
})()
