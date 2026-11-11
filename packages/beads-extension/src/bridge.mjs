import { readConnectorOutput } from '../../../src/shared/extensions/connector-output.mjs'

export async function readWorkspace(client, context, previous) {
  const workspace = context?.workspace
  if (!workspace) {
    const failure = { message: 'No workspace is selected', observedAt: Date.now() }
    return { bdFailure: failure, gcFailure: failure, previous }
  }
  const [bd, bdReady, gc, gcRig] = await Promise.allSettled([
    runConnector(client, context, 'bd', [
      'list',
      '--json',
      '--flat',
      '--no-pager',
      '-n',
      '0',
      '--include-gates',
      '--include-infra',
    ]),
    runConnector(client, context, 'bd', [
      'list',
      '--ready',
      '--json',
      '--flat',
      '--no-pager',
      '-n',
      '0',
      '--include-gates',
      '--include-infra',
    ]),
    runConnector(client, context, 'gc', ['session', 'list', '--json']),
    runConnector(client, context, 'gc', ['rig', 'status', '--json']),
  ])
  const observedAt = Date.now()
  const bdFailure = [bd, bdReady].find((result) => result.status === 'rejected')
  const gcFailure = [gc, gcRig].find((result) => result.status === 'rejected')
  return {
    ...(bdFailure
      ? { bdFailure: { message: message(bdFailure.reason), observedAt } }
      : {
          bd: { text: bd.value, observedAt },
          bdReady: { text: bdReady.value, observedAt },
        }),
    ...(gcFailure
      ? { gcFailure: { message: message(gcFailure.reason), observedAt } }
      : {
          gc: { text: gc.value, observedAt },
          gcRig: { text: gcRig.value, observedAt },
        }),
    previous,
  }
}

async function runConnector(client, context, connector, args) {
  const workspace = context.workspace
  const result = await client.request('connector.execute', {
    connector,
    host: workspace.host,
    workspace: workspace.id,
    args,
  })
  let stdout = ''
  let stderr = ''
  try {
    if (result.receipt) {
      stdout = await readConnectorOutput(client, result)
      stderr = await readConnectorOutput(client, result, { stream: 'stderr' })
    }
    if (result.outcome !== 'completed' || result.code !== 0 || result.truncated)
      throw new Error(
        result.reason ||
          stderr.trim() ||
          `${connector} ${result.outcome} with exit ${String(result.code)}`,
      )
    return stdout
  } finally {
    if (result.receipt)
      await client
        .request('connector.output', { receipt: result.receipt, release: true })
        .catch(() => {})
  }
}

function message(reason) {
  return reason instanceof Error ? reason.message : String(reason)
}
