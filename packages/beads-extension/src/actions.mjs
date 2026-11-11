const beadId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const controls = /[\p{Cc}\u2028\u2029]/u

export function commandForAction(action, input) {
  const value = record(input)
  if (action === 'bead-claim') return ['bd', ['update', id(value.id), '--claim']]
  if (action === 'bead-close') return ['bd', ['close', id(value.id)]]
  if (action === 'bead-create') {
    const args = ['create', '--title', text(value.title, 512)]
    if (value.description !== undefined)
      args.push('--description', text(value.description, 4096))
    return ['bd', args]
  }
  const target = crewTarget(value.target)
  if (action === 'crew-attach') return ['gc', ['session', 'attach', target]]
  if (action === 'crew-peek') return ['gc', ['session', 'peek', target]]
  if (action === 'crew-reset') return ['gc', ['session', 'reset', target]]
  if (action === 'crew-handoff')
    return ['gc', ['handoff', '--target', target, 'hvir handoff']]
  throw new Error('Unsupported command action')
}

export async function executeTerminalAction(client, invocation) {
  const workspace = invocation.context?.workspace
  if (!workspace || typeof workspace.id !== 'string' || !workspace.id)
    throw new Error('An exact workspace is required')
  const [connector, args] = commandForAction(invocation.action, invocation.input)
  return await client.request('terminal.start', {
    connector,
    workspace: workspace.id,
    args,
  })
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid command input')
  return value
}

function id(value) {
  if (typeof value !== 'string' || !beadId.test(value))
    throw new Error('Invalid command input')
  return value
}

function text(value, maximum) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    controls.test(value)
  )
    throw new Error('Invalid command input')
  return value
}

function crewTarget(value) {
  const target = text(value, 256)
  if (target.startsWith('-')) throw new Error('Invalid command input')
  return target
}
