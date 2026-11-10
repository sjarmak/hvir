import { describe, expect, it, vi } from 'vitest'
import { requestGuestConnector } from '../src/main/extensions/guest-connectors'
import type { ConnectorCaller } from '../src/main/extensions/connector-execution'
import type { ExtensionInvocation } from '../src/shared/extensions/contract'

function invocation(caller: ExtensionInvocation['caller']): ExtensionInvocation {
  return {
    id: 'invocation',
    action: 'record',
    input: null,
    context: { surface: 'viewer', visible: true },
    caller,
    authorization: 'interactive',
  }
}
async function callerFor(restricted: boolean, current: ExtensionInvocation | undefined) {
  const execute = vi.fn((_caller: ConnectorCaller) => Promise.resolve({}))
  const authority = { restricted, assertCapability: vi.fn(), forAction: () => undefined }
  const record = {
    authority,
    activation: { installationId: 'installation' },
    view: { id: 'view', role: 'viewer' },
    owner: {},
    selected: true,
    visible: true,
    refreshDemand: true,
    readingOrigin: 'human',
    actions: new Set<string>(),
  }
  const actions = { authority: () => ({ assertCapability: vi.fn() }) }
  await requestGuestConnector(
    'connector.execute',
    {},
    record as never,
    new AbortController().signal,
    () => undefined,
    {} as never,
    { execute } as never,
    {} as never,
    actions as never,
    (() => true),
    current,
    {} as never,
    () => true,
  )
  return execute.mock.calls[0]![0]
}
describe('guest connector caller provenance', () => {
  it('marks a guest invocation from an ordinary view as human and names its action', async () => {
    expect(await callerFor(false, invocation('guest'))).toMatchObject({
      action: 'invocation',
      actionName: 'record',
      human: true,
    })
  })
  it.each([
    ['an agent invocation', false, invocation('agent')],
    ['a human-origin invocation', false, invocation('human')],
    ['a restricted view', true, invocation('guest')],
  ] as const)('does not mark %s as human', async (_label, restricted, current) => {
    expect(await callerFor(restricted, current)).toMatchObject({
      actionName: 'record',
      human: false,
    })
  })
  it('carries no action name or human mark without an invocation', async () => {
    const caller = await callerFor(false, undefined)
    expect(caller.actionName).toBeUndefined()
    expect(caller.human).toBeUndefined()
  })
})
