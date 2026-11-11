import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
vi.mock('electron', () => ({ dialog: {}, BrowserWindow: {}, webContents: {} }))
import {
  ExtensionTerminalHandoff,
  type ConfirmTerminalLaunch,
} from '../src/main/extensions/terminal-handoff'
import type { ExtensionActionOwner } from '../src/main/extensions/action-owner'
import { ExtensionGuestAuthority } from '../src/main/extensions/guest-authority'
import {
  TerminalCommandHandoffOwner,
  type TerminalCommandRequest,
} from '../src/main/terminal/command-handoff-owner'
import type { ExtensionInvocation } from '../src/shared/extensions/contract'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import { connectorFixture } from './fixtures/extension-connector'

const disposers: Array<() => void> = []

interface BeadsActions {
  executeTerminalAction(
    client: { request(capability: string, input: unknown): Promise<unknown> },
    invocation: {
      action: string
      input: unknown
      context: { workspace?: { id: string; host: string } }
    },
  ): Promise<unknown>
}

function beadsActions(): BeadsActions {
  const result = buildSync({
    entryPoints: ['packages/beads-extension/src/actions.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'BeadsActions',
    write: false,
  })
  const context = { BeadsActions: undefined as unknown }
  runInNewContext(result.outputFiles[0]!.text, context)
  return context.BeadsActions as BeadsActions
}
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
async function fixture(
  caller: ExtensionInvocation['caller'] = 'guest',
  authorization: ExtensionInvocation['authorization'] = 'unapproved',
  connectorContext: 'application' | 'workspace' = 'application',
) {
  const f = connectorFixture(connectorContext)
  Object.assign(f.activation.revision.manifest.connectors![0]!, { context: 'workspace' })
  await f.approve()
  const context = {
    value: {
      surface: 'viewer' as const,
      visible: true,
      workspace: { id: 'workspace', name: 'Project', host: f.host.hostId },
    },
    root: hostPath(f.host.hostId, '/workspace'),
    current: () => true,
  }
  const invocation: ExtensionInvocation = {
    id: 'action-once',
    action: 'setup',
    input: {},
    context: context.value,
    caller,
    authorization,
  }
  const actions = {
    provenance: vi.fn<() => ExtensionInvocation | undefined>(() => invocation),
    authority: vi.fn<ExtensionActionOwner['authority']>(() => undefined),
  }
  const confirm = vi.fn<ConfirmTerminalLaunch>(() => Promise.resolve(true)),
    published = vi.fn()
  let request!: TerminalCommandRequest
  const owner = { id: 42, generation: 7 }
  const handoffs = new TerminalCommandHandoffOwner((_owner, value) => {
    request = value
    published(value)
  })
  const adapter = new ExtensionTerminalHandoff(f.approvals, handoffs, actions, confirm)
  disposers.push(() => {
    handoffs.dispose()
    f.dispose()
  })
  const start = (
    input: unknown = {
      connector: 'tool',
      workspace: 'workspace',
      args: ['init', '--no-git'],
    },
    action = invocation,
    signal = f.controller.signal,
  ) =>
    adapter.start(
      {
        owner,
        view: 'view',
        activation: f.activation,
        authority: new ExtensionGuestAuthority(),
        context,
      },
      input,
      action,
      f.caller.current,
      signal,
    )
  const consume = () =>
    handoffs.consume(request.ticket, {
      owner,
      terminalId: request.terminalId,
      workspaceId: request.workspaceId,
      root: context.root,
    })
  return { f, context, invocation, actions, confirm, published, start, consume, handoffs }
}

describe('extension terminal handoff authority', () => {
  it.each(['authority', 'context'] as const)(
    'does no metadata work when terminal %s is refused',
    async (fence) => {
      const f = await fixture()
      f.f.host.realpath.mockClear()
      f.f.host.stat.mockClear()
      if (fence === 'authority')
        f.actions.authority.mockReturnValue({
          assertCapability: () => {
            throw new Error('Denied terminal capability')
          },
        })
      else f.context.current = () => false
      await expect(f.start()).rejects.toThrow()
      expect(f.f.host.realpath).not.toHaveBeenCalled()
      expect(f.f.host.stat).not.toHaveBeenCalled()
      expect(f.confirm).not.toHaveBeenCalled()
      expect(f.published).not.toHaveBeenCalled()
    },
  )
  it('retains active metadata admission for cancelled terminal resolutions until settlement', async () => {
    const f = await fixture()
    const finishes: (() => void)[] = []
    f.f.host.realpath.mockImplementation(
      () =>
        new Promise((resolve) =>
          finishes.push(() => resolve(localPath('/installed/tool'))),
        ),
    )
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const pending = controllers.map((controller, index) =>
      f.start(undefined, { ...f.invocation, id: 'action-' + index }, controller.signal),
    )
    const settled = Promise.allSettled(pending)
    expect(finishes).toHaveLength(4)
    controllers.forEach((controller) => controller.abort())
    await expect(f.start(undefined, { ...f.invocation, id: 'overflow' })).rejects.toThrow(
      'capacity',
    )
    expect(finishes).toHaveLength(4)
    finishes.forEach((finish) => finish())
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.published).not.toHaveBeenCalled()
    f.f.host.realpath.mockResolvedValue(localPath('/installed/tool'))
    expect(
      await f.f.approvals.resolve(
        f.f.activation,
        f.f.approvals.get(f.f.activation, 'tool', 'local')!,
      ),
    ).toHaveProperty('executable', '/installed/tool')
  })

  it.each(['unchanged', 'retarget', 'off'] as const)(
    'pins a session-trusted terminal command through %s consent',
    async (fence) => {
      const f = await fixture()
      const approval = f.f.approvals.get(f.f.activation, 'tool', 'local')!
      f.f.host.realpath.mockResolvedValue(localPath('/versions/B/tool'))
      const prepared = await f.f.approvals.prepare(
        approval,
        () => undefined,
        undefined,
        true,
      )
      await f.f.approvals.approve(prepared.token)
      f.confirm.mockImplementationOnce(() => {
        if (fence === 'retarget')
          f.f.host.realpath.mockResolvedValue(localPath('/versions/C/tool'))
        if (fence === 'off') f.f.approvals.endSession(approval)
        return Promise.resolve(true)
      })
      const result = f.start()
      if (fence !== 'unchanged') {
        expect(await result).toMatchObject({ outcome: 'not-started' })
        expect(f.published).not.toHaveBeenCalled()
        return
      }
      await vi.waitFor(() => expect(f.published).toHaveBeenCalledOnce())
      const lease = f.consume()
      expect(lease.command.executable).toBe('/versions/B/tool')
      expect(f.confirm.mock.calls[0]?.[0].details).toContain('/versions/B/tool')
      await lease.prepareDispatch()
      lease.dispatched()
      lease.finish(true)
      expect(await result).toMatchObject({ outcome: 'handed-off' })
      f.f.approvals.endSession(approval)
      expect(lease.command.executable).toBe('/versions/B/tool')
    },
  )
  it('selects local terminal approval after the same connector gains an independent SSH binding', async () => {
    const f = await fixture()
    const hosts = f.f.hosts,
      local = hosts.hostById('local')!
    const remote = { ...local, hostId: asHostId('remote') }
    vi.spyOn(hosts, 'listHosts').mockReturnValue([
      ...hosts.listHosts(),
      {
        hostId: remote.hostId,
        label: 'Remote',
        kind: 'ssh',
        connectionState: 'connected',
        watchTier: 'polling',
      },
    ])
    vi.spyOn(hosts, 'hostById').mockImplementation((id) =>
      id === 'local' ? local : remote,
    )
    vi.spyOn(hosts, 'materializeHost').mockResolvedValue(remote)
    const prepared = await f.f.approvals.prepare(
      {
        installationId: 'installation',
        connector: 'tool',
        host: 'remote',
        executable: '/remote/tool',
        configuration: { args: [], env: {} },
      },
      () => undefined,
    )
    await f.f.approvals.approve(prepared.token)
    const result = f.start()
    await vi.waitFor(() => expect(f.published).toHaveBeenCalledOnce())
    const lease = f.consume()
    expect(lease.command.executable).toBe('/installed/tool')
    await lease.prepareDispatch()
    lease.dispatched()
    lease.finish(true)
    expect(await result).toMatchObject({ outcome: 'handed-off' })
    expect(f.f.approvals.get(f.f.activation, 'tool', 'remote')).toBe(prepared.approval)
  })
  it('hands an SSH workspace command to its exact host with the canonical executable', async () => {
    const f = await fixture('guest', 'unapproved', 'workspace')
    f.f.host.realpath.mockResolvedValue(hostPath(f.f.host.hostId, '/remote/bin/tool'))
    await f.f.approve('/remote/tool')
    f.f.host.realpath.mockClear()
    const result = f.start()
    await vi.waitFor(() => expect(f.published).toHaveBeenCalledOnce())
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.confirm.mock.calls[0]?.[0]).toMatchObject({
      destination: 'remote: /workspace',
      command: 'Run tool once in a new terminal',
    })
    expect(f.confirm.mock.calls[0]?.[0].details).toContain('/remote/bin/tool')
    expect(f.published.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'workspace',
      root: hostPath(f.f.host.hostId, '/workspace'),
    })
    const lease = f.consume()
    expect(lease.command).toEqual({
      executable: '/remote/bin/tool',
      args: ['--json', 'init', '--no-git'],
      environment: { TOOL_HOME: '/library' },
    })
    await lease.prepareDispatch()
    expect(f.f.host.realpath).toHaveBeenCalledWith(
      hostPath(f.f.host.hostId, '/remote/tool'),
    )
    lease.dispatched()
    lease.finish(true)
    expect(await result).toMatchObject({ outcome: 'handed-off' })
    expect(f.f.host.exec).not.toHaveBeenCalled()
  })
  it.each(['local', 'workspace'] as const)(
    'refuses to borrow a %s connector approval for another host',
    async (binding) => {
      const f = await fixture(
        'guest',
        'unapproved',
        binding === 'local' ? 'application' : 'workspace',
      )
      f.context.root = hostPath(asHostId('other-host'), '/workspace')
      f.context.value.workspace.host = asHostId('other-host')
      f.f.host.realpath.mockClear()
      await expect(f.start()).rejects.toThrow('exact workspace')
      expect(f.f.host.realpath).not.toHaveBeenCalled()
      expect(f.confirm).not.toHaveBeenCalled()
      expect(f.published).not.toHaveBeenCalled()
    },
  )
  it('asks once for the exact command and destination, then freezes the approved prefix/config', async () => {
    const f = await fixture(),
      result = f.start()
    await vi.waitFor(() => expect(f.published).toHaveBeenCalledOnce())
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.confirm.mock.calls[0]?.[0]).toMatchObject({
      destination: 'local: /workspace',
      command: 'Run tool once in a new terminal',
    })
    const lease = f.consume()
    expect(lease.command).toEqual({
      executable: '/installed/tool',
      args: ['--json', 'init', '--no-git'],
      environment: { TOOL_HOME: '/library' },
    })
    await lease.prepareDispatch()
    lease.dispatched()
    lease.finish(true)
    expect(await result).toMatchObject({ outcome: 'handed-off' })
    await expect(f.start()).rejects.toThrow('already requested')
  })
  it.each(['standing', 'interactive'] as const)(
    'consumes admitted agent %s authority without another human modal',
    async (authorization) => {
      const f = await fixture('agent', authorization),
        result = f.start()
      await vi.waitFor(() => expect(f.published).toHaveBeenCalledOnce())
      expect(f.confirm).not.toHaveBeenCalled()
      const lease = f.consume()
      await lease.prepareDispatch()
      lease.dispatched()
      lease.finish(true)
      expect(await result).toMatchObject({ outcome: 'handed-off' })
    },
  )
  it('refuses an unapproved agent origin rather than manufacturing a human launch', async () => {
    const f = await fixture('agent')
    expect(await f.start()).toMatchObject({ outcome: 'not-started' })
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.published).not.toHaveBeenCalled()
  })
  it('revocation during the native decision cannot publish a late ticket', async () => {
    const f = await fixture()
    let release!: (accepted: boolean) => void
    let settled!: () => void
    const preparationSettled = new Promise<void>((resolve) => {
      settled = resolve
    })
    const request = f.handoffs.request.bind(f.handoffs)
    vi.spyOn(f.handoffs, 'request').mockImplementation((input) =>
      request({
        ...input,
        prepare: async (signal) => {
          try {
            return await input.prepare!(signal)
          } finally {
            settled()
          }
        },
      }),
    )
    f.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const result = f.start()
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
    f.f.controller.abort()
    expect(await result).toMatchObject({ outcome: 'not-started' })
    release(true)
    await preparationSettled
    expect(f.published).not.toHaveBeenCalled()
    expect(f.f.host.exec).not.toHaveBeenCalled()
  })
  it('refuses executable replacement at final admission and keeps dispatch unstarted', async () => {
    const f = await fixture(),
      result = f.start()
    await vi.waitFor(() => expect(f.published).toHaveBeenCalledOnce())
    const lease = f.consume()
    f.f.host.realpath.mockImplementationOnce(() =>
      Promise.resolve(localPath('/changed/tool')),
    )
    await expect(lease.prepareDispatch()).rejects.toThrow('changed')
    lease.finish(false)
    expect(await result).toMatchObject({ outcome: 'not-started' })
    expect(f.f.host.exec).not.toHaveBeenCalled()
  })
  it('requires main provenance and the exact approved workspace connector', async () => {
    const f = await fixture()
    f.actions.provenance.mockImplementationOnce(() => undefined)
    await expect(f.start()).rejects.toThrow('current explicit action')
    await expect(
      f.start({ connector: 'tool', workspace: 'alias', args: [] }),
    ).rejects.toThrow('exact workspace')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.published).not.toHaveBeenCalled()
  })
})

describe('Beads package terminal actions', () => {
  it.each([
    ['bead-claim', { id: 'hvir-123' }, 'bd', ['update', 'hvir-123', '--claim']],
    ['bead-close', { id: 'hvir-123' }, 'bd', ['close', 'hvir-123']],
    [
      'bead-create',
      { title: 'Add command handoffs', description: 'Phase four' },
      'bd',
      ['create', '--title', 'Add command handoffs', '--description', 'Phase four'],
    ],
    ['crew-attach', { target: 'hvir-worker' }, 'gc', ['session', 'attach', 'hvir-worker']],
    ['crew-peek', { target: 'hvir-worker' }, 'gc', ['session', 'peek', 'hvir-worker']],
    ['crew-reset', { target: 'hvir-worker' }, 'gc', ['session', 'reset', 'hvir-worker']],
    [
      'crew-handoff',
      { target: 'hvir-worker' },
      'gc',
      ['handoff', '--target', 'hvir-worker', 'hvir handoff'],
    ],
  ])('maps %s to one structured command-once handoff', async (action, input, connector, args) => {
    const request = vi.fn(() => Promise.resolve({ outcome: 'handed-off' }))
    await expect(
      beadsActions().executeTerminalAction(
        { request },
        {
          action,
          input,
          context: { workspace: { id: 'workspace-1', host: 'ssh-a' } },
        },
      ),
    ).resolves.toEqual({ outcome: 'handed-off' })
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('terminal.start', {
      connector,
      workspace: 'workspace-1',
      args,
    })
  })

  it('requests a fresh handoff for every repeated attach invocation', async () => {
    const request = vi.fn(() => Promise.resolve({ outcome: 'handed-off' }))
    const invocation = {
      action: 'crew-attach',
      input: { target: 'hvir-worker' },
      context: { workspace: { id: 'workspace-1', host: 'local' } },
    }
    const api = beadsActions()
    await api.executeTerminalAction({ request }, invocation)
    await api.executeTerminalAction({ request }, invocation)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('refuses missing workspace identity and malformed command input', async () => {
    const request = vi.fn(() => Promise.resolve())
    const api = beadsActions()
    await expect(
      api.executeTerminalAction(
        { request },
        { action: 'bead-claim', input: { id: 'hvir-1' }, context: {} },
      ),
    ).rejects.toThrow('workspace')
    await expect(
      api.executeTerminalAction(
        { request },
        {
          action: 'bead-claim',
          input: { id: 'bad id' },
          context: { workspace: { id: 'workspace-1', host: 'local' } },
        },
      ),
    ).rejects.toThrow('input')
    expect(request).not.toHaveBeenCalled()
  })
})
