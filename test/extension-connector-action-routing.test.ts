import { afterEach, describe, expect, it, vi } from 'vitest'
import { attached, fixture } from './fixtures/extension-guest'
import { connectorFixture } from './fixtures/extension-connector'
import { exampleManifest } from './fixtures/extension-package'
import {
  DEFAULT_EXTENSION_PRESENTATION,
  type ExtensionGuestOwner,
} from '../src/main/extensions/guest-owner'
import type { ExtensionActionAuthority } from '../src/main/extensions/action-owner'
import type { ExtensionViewAuthority } from '../src/main/extensions/guest-authority'
import type { ExtensionInvocation } from '../src/shared/extensions/contract'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const action = (id: string, view = 'reference') => ({
  id,
  title: id,
  view,
  agents: false,
  effects: { delete: false, replace: false },
})
const declaration = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  description: id,
  context: 'application',
  timeoutMs: 1000,
  outputBytes: 1000,
  environment: [],
  ...extra,
})

async function setup() {
  const data = fixture(
    {},
    {
      optionalCapabilities: [
        'connector.execute',
        'connector.output',
        'connector.action-binding',
        'actions.invoke',
      ],
      views: [
        exampleManifest().views[0]!,
        {
          ...exampleManifest().views[1]!,
          id: 'second',
          entry: 'detail.html',
        },
      ],
      actions: [action('record'), action('other'), action('elsewhere', 'second')],
      actionConnectors: [declaration('bound', { actions: ['record'] })],
      connectors: [declaration('free')],
    },
    undefined,
    {
      connectors: {
        approvals: { inspectStatus: () => Promise.resolve([]) },
        execute: (caller, input) => native.execution.execute(caller, input),
        output: (caller, input) => native.execution.output(caller, input),
        revalidate: () => native.execution.revalidate(),
      },
    },
  )
  const activation = [...data.active.values()][0]!
  const native = connectorFixture(
    'application',
    undefined,
    undefined,
    activation.revision,
  )
  native.active.set('installation', activation)
  await native.approvals.start()
  for (const connector of ['bound', 'free']) {
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
  cleanups.push(async () => {
    native.dispose()
    await data.owner.dispose()
  })
  const hello = (guest: number): void =>
    data.owner.receive(guest, { kind: 'hello', contract: '1.0' })
  const request = async (
    guest: number,
    id: string,
    capability: string,
    input: unknown,
    actionId?: string,
  ) => {
    data.owner.receive(guest, {
      kind: 'request',
      id,
      capability,
      input,
      ...(actionId ? { actionId } : {}),
    })
    await vi.waitFor(() =>
      expect(
        data.sent.some(
          (entry) => entry.message.kind === 'result' && entry.message.id === id,
        ),
      ).toBe(true),
    )
    return data.sent.find(
      (entry) => entry.message.kind === 'result' && entry.message.id === id,
    )!.message as { ok: boolean; value?: Record<string, unknown>; error?: string }
  }
  const delivered = (name: string, guest = 10): ExtensionInvocation => {
    const entry = data.sent.find(
      (item) =>
        item.guestId === guest &&
        item.message.kind === 'action' &&
        item.message.invocation.action === name,
    )
    if (!entry || entry.message.kind !== 'action')
      throw new Error('No delivered invocation')
    return entry.message.invocation
  }
  const open = async (
    guest = 10,
    contribution = 'reference',
    origin: 'human' | 'action' = 'action',
  ) => {
    const view = await attached(data, guest, origin, contribution)
    hello(guest)
    return view
  }
  const invoke = async (
    name: string,
    caller: ExtensionInvocation['caller'],
    guest = 10,
  ) => {
    const operation = data.actions.invoke(
      data.renderer,
      activation,
      name,
      null,
      { surface: 'viewer' },
      caller,
      'interactive',
      () => undefined,
    )
    operation.catch(() => undefined)
    await vi.waitFor(() => delivered(name, guest))
    return { operation, invocation: delivered(name, guest) }
  }
  const attach = (
    opened: ReturnType<ExtensionGuestOwner['snapshot']>[number],
    guest: number,
  ): void => {
    data.owner.claim(data.renderer, opened.partition, opened.url, opened.id)
    data.owner.bind(data.renderer, opened.partition, guest)
    data.owner.presentation(
      data.renderer,
      opened.id,
      DEFAULT_EXTENSION_PRESENTATION,
      true,
      true,
    )
    hello(guest)
  }
  const finish = (invocation: ExtensionInvocation, guest = 10): void =>
    data.owner.receive(guest, { kind: 'action-result', id: invocation.id, value: null })
  const input = { connector: 'bound', host: 'local', args: ['status'] }
  return {
    data,
    native,
    activation,
    request,
    delivered,
    open,
    attach,
    invoke,
    finish,
    input,
    hello,
  }
}
const refused = (message: { ok: boolean; value?: Record<string, unknown> }) =>
  message.ok
    ? expect(message.value).toMatchObject({
        outcome: 'not-started',
        reason: 'unavailable',
      })
    : expect(message.ok).toBe(false)

function admitted(sent: ReturnType<typeof fixture>['sent']): readonly string[] {
  for (const { message } of sent)
    if (message.kind === 'hello') return message.capabilities
  return []
}

describe('routed action-bound connector callers', () => {
  it('admits the action-binding capability in the guest handshake only when declared', async () => {
    const f = await setup()
    await f.open()
    expect(admitted(f.data.sent)).toContain('connector.action-binding')
    const bare = fixture({}, { optionalCapabilities: ['connector.execute'] })
    cleanups.push(() => bare.owner.dispose())
    await attached(bare)
    bare.owner.receive(10, { kind: 'hello', contract: '1.0' })
    expect(admitted(bare.sent)).toContain('connector.execute')
    expect(admitted(bare.sent)).not.toContain('connector.action-binding')
  })
  it('runs and pages a bound connector for a genuine workbench human invocation', async () => {
    const f = await setup()
    await f.open()
    const { operation, invocation } = await f.invoke('record', 'human')
    const result = await f.request(10, 'run', 'connector.execute', f.input, invocation.id)
    expect(result).toMatchObject({ ok: true, value: { outcome: 'completed' } })
    const page = await f.request(
      10,
      'page',
      'connector.output',
      {
        receipt: result.value!['receipt'],
        stream: 'stdout',
        offset: 0,
      },
      invocation.id,
    )
    expect(page).toMatchObject({ ok: true, value: { data: 'result' } })
    f.finish(invocation)
    await operation
  })
  it('runs a bound connector for a genuine guest-issued invocation of its own action', async () => {
    const f = await setup()
    const page = await f.open(10, 'reference', 'human')
    const pending = f.request(10, 'invoke', 'actions.invoke', { action: 'record' })
    const opened = await vi.waitFor(() => {
      const view = f.data.owner
        .snapshot(f.data.renderer)
        .find((entry) => entry.id !== page.id)
      if (!view) throw new Error('No action view')
      return view
    })
    f.attach(opened, 12)
    const invocation = await vi.waitFor(() => f.delivered('record', 12))
    expect(invocation.caller).toBe('guest')
    const result = await f.request(12, 'run', 'connector.execute', f.input, invocation.id)
    expect(result).toMatchObject({ ok: true, value: { outcome: 'completed' } })
    const paged = await f.request(
      12,
      'page',
      'connector.output',
      {
        receipt: result.value!['receipt'],
        stream: 'stdout',
        offset: 0,
      },
      invocation.id,
    )
    expect(paged).toMatchObject({ ok: true, value: { data: 'result' } })
    f.finish(invocation, 12)
    expect((await pending).ok).toBe(true)
  })
  it('refuses a bound connector with no invocation or a forged invocation id, for execute and output', async () => {
    const f = await setup()
    await f.open()
    refused(await f.request(10, 'none', 'connector.execute', f.input))
    refused(await f.request(10, 'forged', 'connector.execute', f.input, 'forged-id'))
    const { invocation } = await f.invoke('record', 'human')
    const run = await f.request(10, 'run', 'connector.execute', f.input, invocation.id)
    const receipt = run.value!['receipt']
    for (const actionId of [undefined, 'forged-id'])
      expect(
        (
          await f.request(
            10,
            `page-${actionId}`,
            'connector.output',
            { receipt, stream: 'stdout', offset: 0 },
            actionId,
          )
        ).ok,
      ).toBe(false)
    expect(f.native.host.exec).toHaveBeenCalledTimes(1)
  })
  it('refuses a completed invocation id for execute and output', async () => {
    const f = await setup()
    await f.open()
    const { operation, invocation } = await f.invoke('record', 'human')
    const run = await f.request(10, 'run', 'connector.execute', f.input, invocation.id)
    f.finish(invocation)
    await operation
    refused(await f.request(10, 'again', 'connector.execute', f.input, invocation.id))
    expect(
      (
        await f.request(
          10,
          'late-page',
          'connector.output',
          { receipt: run.value!['receipt'], stream: 'stdout', offset: 0 },
          invocation.id,
        )
      ).ok,
    ).toBe(false)
    expect(f.native.host.exec).toHaveBeenCalledTimes(1)
  })
  it('refuses an invocation id presented by another view, for execute and output', async () => {
    const f = await setup()
    await f.open()
    await f.open(11, 'second')
    const { invocation } = await f.invoke('record', 'human')
    const run = await f.request(10, 'run', 'connector.execute', f.input, invocation.id)
    refused(await f.request(11, 'cross', 'connector.execute', f.input, invocation.id))
    expect(
      (
        await f.request(
          11,
          'cross-page',
          'connector.output',
          { receipt: run.value!['receipt'], stream: 'stdout', offset: 0 },
          invocation.id,
        )
      ).ok,
    ).toBe(false)
    expect(f.native.host.exec).toHaveBeenCalledTimes(1)
  })
  it('refuses another action invocation for execute and output, and ids from the wrong view action', async () => {
    const f = await setup()
    await f.open()
    await f.open(11, 'second')
    const record = await f.invoke('record', 'human')
    const other = await f.invoke('other', 'human')
    const elsewhere = await f.invoke('elsewhere', 'human', 11)
    const run = await f.request(
      10,
      'run',
      'connector.execute',
      f.input,
      record.invocation.id,
    )
    refused(
      await f.request(10, 'wrong', 'connector.execute', f.input, other.invocation.id),
    )
    refused(
      await f.request(
        11,
        'wrong-view',
        'connector.execute',
        f.input,
        elsewhere.invocation.id,
      ),
    )
    expect(
      (
        await f.request(
          10,
          'wrong-page',
          'connector.output',
          { receipt: run.value!['receipt'], stream: 'stdout', offset: 0 },
          other.invocation.id,
        )
      ).ok,
    ).toBe(false)
    expect(f.native.host.exec).toHaveBeenCalledTimes(1)
  })
  it('leaves an unbound connector available with and without an invocation', async () => {
    const f = await setup()
    await f.open()
    const free = { ...f.input, connector: 'free' }
    expect(await f.request(10, 'plain', 'connector.execute', free)).toMatchObject({
      ok: true,
      value: { outcome: 'completed' },
    })
    const { invocation } = await f.invoke('other', 'human')
    expect(
      await f.request(10, 'invoked', 'connector.execute', free, invocation.id),
    ).toMatchObject({ ok: true, value: { outcome: 'completed' } })
  })
  describe('agent, restricted and ssh-forwarded origins', () => {
    const authority = (forwarded: boolean): ExtensionActionAuthority => {
      const view: ExtensionViewAuthority = {
        forwarded,
        key: forwarded ? 'ssh' : 'local-agent',
        signal: new AbortController().signal,
        current: () => undefined,
        assertCapability: () => undefined,
        forAction: () => authorityFor(view),
      }
      return authorityFor(view)
    }
    const authorityFor = (view: ExtensionViewAuthority): ExtensionActionAuthority => ({
      view,
      assertCapability: () => undefined,
      forAction: () => authorityFor(view),
    })
    it('refuses an agent invocation of the action before any view opens', async () => {
      const f = await setup()
      await f.open()
      expect(() =>
        f.data.actions.invoke(
          f.data.renderer,
          f.activation,
          'record',
          null,
          { surface: 'viewer' },
          'agent',
          'standing',
          () => undefined,
        ),
      ).toThrow('unavailable')
      expect(f.native.host.exec).not.toHaveBeenCalled()
    })
    it.each([
      ['a local agent', false],
      ['an ssh-forwarded agent', true],
    ])('refuses %s views for execute and output', async (_label, forwarded) => {
      const f = await setup()
      const operation = f.data.actions.invoke(
        f.data.renderer,
        f.activation,
        'record',
        null,
        { surface: 'viewer' },
        'human',
        'standing',
        () => undefined,
        undefined,
        authority(forwarded),
      )
      operation.catch(() => undefined)
      const opened = await vi.waitFor(() => {
        const view = f.data.owner.snapshot(f.data.renderer).at(0)
        if (!view) throw new Error('No opened view')
        return view
      })
      f.attach(opened, 10)
      const invocation = await vi.waitFor(() => f.delivered('record'))
      refused(await f.request(10, 'run', 'connector.execute', f.input, invocation.id))
      expect(
        (
          await f.request(
            10,
            'page',
            'connector.output',
            { receipt: 'none', stream: 'stdout', offset: 0 },
            invocation.id,
          )
        ).ok,
      ).toBe(false)
      expect(f.native.host.exec).not.toHaveBeenCalled()
    })
  })
})
