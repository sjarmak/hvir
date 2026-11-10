import { describe, expect, it } from 'vitest'
import { connectorFixture } from './fixtures/extension-connector'
import { ExtensionConnectorApprovalOwner } from '../src/main/extensions/connector-approval'
import { validateConnectorDeclarations } from '../src/shared/extensions/connectors'
import type { ExtensionActivation } from '../src/main/extensions/activation'

const declaration = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  description: id,
  context: 'application',
  timeoutMs: 1000,
  outputBytes: 1000,
  environment: [],
  ...extra,
})

async function saved() {
  const base = connectorFixture('application')
  const revision = {
    ...base.activation.revision,
    manifest: {
      ...base.activation.revision.manifest,
      connectors: [
        ...validateConnectorDeclarations([declaration('free')], () => undefined),
        ...validateConnectorDeclarations(
          [declaration('bound', { actions: ['record'] })],
          () => undefined,
          true,
        ),
      ],
    },
  } as unknown as ExtensionActivation['revision']
  const native = connectorFixture('application', undefined, undefined, revision)
  for (const connector of ['free', 'bound']) {
    const prepared = await native.approvals.prepare(
      {
        installationId: 'installation',
        connector,
        host: 'local',
        executable: '/installed/tool',
        configuration: { args: [], env: {} },
      },
      () => undefined,
    )
    await native.approvals.approve(prepared.token)
  }
  const restart = async () => {
    const owner = new ExtensionConnectorApprovalOwner(
      native.hosts,
      native.authority,
      () => undefined,
    )
    await owner.start()
    return owner
  }
  return { native, restart }
}

describe('persisted action-bound connector approvals', () => {
  it('resolves a bound and an ordinary approval after a restart', async () => {
    const { native, restart } = await saved()
    const owner = await restart()
    expect(owner.get(native.activation, 'bound', 'local')).toBeDefined()
    expect(owner.get(native.activation, 'free', 'local')).toBeDefined()
    owner.dispose()
  })
  it('keeps the other approvals readable when a persisted ordinary entry gains actions', async () => {
    const { native, restart } = await saved()
    const records = native.state() as { connector: string; declaration: object }[]
    native.setState(
      records.map((entry) =>
        entry.connector === 'free'
          ? { ...entry, declaration: { ...entry.declaration, actions: ['record'] } }
          : entry,
      ),
    )
    const owner = await restart()
    expect(owner.get(native.activation, 'free', 'local')).toBeUndefined()
    expect(owner.get(native.activation, 'bound', 'local')).toBeDefined()
    owner.dispose()
  })
  it('does not honor a persisted bound entry whose actions were removed', async () => {
    const { native, restart } = await saved()
    const records = native.state() as {
      connector: string
      declaration: Record<string, unknown>
    }[]
    native.setState(
      records.map((entry) => {
        const { actions: _removed, ...rest } = entry.declaration
        return entry.connector === 'bound' ? { ...entry, declaration: rest } : entry
      }),
    )
    const owner = await restart()
    expect(owner.get(native.activation, 'bound', 'local')).toBeUndefined()
    expect(owner.get(native.activation, 'free', 'local')).toBeDefined()
    owner.dispose()
  })
})
