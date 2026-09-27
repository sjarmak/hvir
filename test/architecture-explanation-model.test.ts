import { expect, it, vi } from 'vitest'
import { asHarnessProfileId, asHarnessProviderId, localPath } from '../src/shared'
import type { HarnessProfile } from '../src/shared'
import type { ProjectHost } from '../src/main/project-host'
import type { ExecStreamHandle, ExecOptions } from '../src/main/project-host'
import { HarnessArchitectureExplanationModel } from '../src/main/harness/architecture-explanation-model'
import type { HarnessProfileStoreContract } from '../src/main/harness/harness-profile-store'

const root = localPath('/repo')

function profile(providerId: 'claude-code' | 'codex'): HarnessProfile {
  return {
    id: asHarnessProfileId(`${providerId}-profile`),
    displayName: providerId,
    providerId: asHarnessProviderId(providerId),
    identityId: providerId === 'claude-code' ? 'claude-3' : undefined,
    launchRevision: providerId === 'claude-code' ? 4 : 2,
    metadataRevision: 1,
    providerContractVersion: providerId === 'claude-code' ? 4 : 2,
    builtIn: false,
    scope: { kind: 'global' },
    executable: { kind: 'provider-default' },
    args: [],
    environment: [],
    pathBindings: [],
    order: 1,
  }
}

function fixture(providerId: 'claude-code' | 'codex') {
  const selected = profile(providerId)
  const execStream = vi.fn(
    (_command: string, _args: readonly string[], _options?: ExecOptions) =>
      stream(['{"version":', '1}']),
  )
  const exec = vi.fn<ProjectHost['exec']>(() =>
    Promise.resolve({ stdout: '/home/test\n', stderr: '', code: 0, signal: null }),
  )
  const host = {
    hostId: root.hostId,
    realpath: (path: typeof root) => Promise.resolve(path),
    defaultShell: () => Promise.resolve('/bin/sh'),
    exec,
    execStream,
  } as unknown as ProjectHost
  const store = {
    get: (id: HarnessProfile['id']) => (id === selected.id ? selected : undefined),
    hasPathGrant: () => false,
  } as unknown as HarnessProfileStoreContract
  return {
    selected,
    exec,
    execStream,
    host,
    model: new HarnessArchitectureExplanationModel(store),
  }
}

function stream(
  stdout: readonly string[],
  stderr: readonly string[] = [],
  code = 0,
): ExecStreamHandle {
  let stdoutHandler: (chunk: string) => void = () => undefined
  let stderrHandler: (chunk: string) => void = () => undefined
  let exitHandler: (result: {
    code: number | null
    signal: string | null
  }) => void = () => undefined
  return {
    onStdout(handler) {
      stdoutHandler = handler
      return () => undefined
    },
    onStderr(handler) {
      stderrHandler = handler
      return () => undefined
    },
    onError() {
      return () => undefined
    },
    onExit(handler) {
      exitHandler = handler
      return () => undefined
    },
    write: () => Promise.resolve(),
    end: () => {
      queueMicrotask(() => {
        stdout.forEach(stdoutHandler)
        stderr.forEach(stderrHandler)
        exitHandler({ code, signal: null })
      })
      return Promise.resolve()
    },
    kill: vi.fn(),
    dispose: vi.fn(),
  }
}

it('runs Claude Code as one tool-free model call with the prompt on stdin', async () => {
  const f = fixture('claude-code')
  const onOutput = vi.fn()
  await expect(
    f.model.generate(f.host, {
      projectRoot: root,
      workspaceRoot: root,
      profileId: f.selected.id,
      launchRevision: f.selected.launchRevision,
      prompt: 'Explain this exact snapshot without tools.',
      signal: new AbortController().signal,
      onOutput,
    }),
  ).resolves.toBe('{"version":1}')
  expect(f.execStream).toHaveBeenCalledOnce()
  expect(f.execStream.mock.calls[0]?.[2]).toMatchObject({
    cwd: root,
    env: { CLAUDE_CONFIG_DIR: '/home/test/.claude-homes/account3/.claude' },
    keepStdinOpen: true,
    loginShell: true,
  })
  expect(f.exec).toHaveBeenCalledWith('printenv', ['HOME'], expect.any(Object))
  expect(f.execStream.mock.calls[0]?.[1]).toEqual([
    '--print',
    '--no-session-persistence',
    '--safe-mode',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--output-format',
    'text',
  ])
  expect(onOutput.mock.calls).toEqual([[expect.any(String)], ['{"version":1}']])
})

it('rejects Codex because its read-only sandbox still exposes repository tools', async () => {
  const f = fixture('codex')
  await expect(
    f.model.generate(f.host, {
      projectRoot: root,
      workspaceRoot: root,
      profileId: f.selected.id,
      launchRevision: f.selected.launchRevision,
      prompt: 'prompt',
      signal: new AbortController().signal,
      onOutput: vi.fn(),
    }),
  ).rejects.toThrow(/cannot explain architecture/)
  expect(f.execStream).not.toHaveBeenCalled()
})

it('surfaces stdout detail when the process fails with empty stderr', async () => {
  const f = fixture('claude-code')
  f.execStream.mockImplementation(() =>
    stream([], ['Not logged in · Please run /login'], 1),
  )
  await expect(
    f.model.generate(f.host, {
      projectRoot: root,
      workspaceRoot: root,
      profileId: f.selected.id,
      launchRevision: f.selected.launchRevision,
      prompt: 'Explain this exact snapshot without tools.',
      signal: new AbortController().signal,
      onOutput: vi.fn(),
    }),
  ).rejects.toThrow(/Not logged in/)
})

it('rejects streamed output beyond the model response budget', async () => {
  const f = fixture('claude-code')
  f.execStream.mockImplementation(() => stream(['x'.repeat(128 * 1024 + 1)]))

  await expect(
    f.model.generate(f.host, {
      projectRoot: root,
      workspaceRoot: root,
      profileId: f.selected.id,
      launchRevision: f.selected.launchRevision,
      prompt: 'Explain this exact snapshot without tools.',
      signal: new AbortController().signal,
      onOutput: vi.fn(),
    }),
  ).rejects.toThrow(/output exceeded 131072 bytes/)
})

it('rejects customized profiles before starting a process', async () => {
  const f = fixture('claude-code')
  const customized = {
    ...f.selected,
    args: [{ parts: [{ kind: 'literal' as const, value: '--full-auto' }] }],
  }
  const store = {
    get: () => customized,
    hasPathGrant: () => false,
  } as unknown as HarnessProfileStoreContract
  const model = new HarnessArchitectureExplanationModel(store)
  await expect(
    model.generate(f.host, {
      projectRoot: root,
      workspaceRoot: root,
      profileId: customized.id,
      launchRevision: customized.launchRevision,
      prompt: 'prompt',
      signal: new AbortController().signal,
      onOutput: vi.fn(),
    }),
  ).rejects.toThrow(/default executable.*no custom arguments/)
  expect(f.execStream).not.toHaveBeenCalled()
})
