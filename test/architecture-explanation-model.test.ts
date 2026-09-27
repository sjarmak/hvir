import { expect, it, vi } from 'vitest'
import { asHarnessProfileId, asHarnessProviderId, localPath } from '../src/shared'
import type { HarnessProfile } from '../src/shared'
import type { ProjectHost } from '../src/main/project-host'
import { HarnessArchitectureExplanationModel } from '../src/main/harness/architecture-explanation-model'
import type { HarnessProfileStoreContract } from '../src/main/harness/harness-profile-store'

const root = localPath('/repo')

function profile(providerId: 'claude-code' | 'codex'): HarnessProfile {
  return {
    id: asHarnessProfileId(`${providerId}-profile`),
    displayName: providerId,
    providerId: asHarnessProviderId(providerId),
    launchRevision: providerId === 'claude-code' ? 3 : 2,
    metadataRevision: 1,
    providerContractVersion: providerId === 'claude-code' ? 3 : 2,
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
  const exec = vi.fn<ProjectHost['exec']>(() =>
    Promise.resolve({ stdout: '{"version":1}', stderr: '', code: 0, signal: null }),
  )
  const host = {
    hostId: root.hostId,
    realpath: (path: typeof root) => Promise.resolve(path),
    defaultShell: () => Promise.resolve('/bin/sh'),
    exec,
  } as unknown as ProjectHost
  const store = {
    get: (id: HarnessProfile['id']) => (id === selected.id ? selected : undefined),
    hasPathGrant: () => false,
  } as unknown as HarnessProfileStoreContract
  return { selected, exec, host, model: new HarnessArchitectureExplanationModel(store) }
}

it('runs Claude Code as one tool-free model call with the prompt on stdin', async () => {
  const f = fixture('claude-code')
  await expect(
    f.model.generate(f.host, {
      projectRoot: root,
      workspaceRoot: root,
      profileId: f.selected.id,
      launchRevision: f.selected.launchRevision,
      prompt: 'Explain this exact snapshot without tools.',
      signal: new AbortController().signal,
    }),
  ).resolves.toBe('{"version":1}')
  expect(f.exec).toHaveBeenCalledOnce()
  expect(f.exec.mock.calls[0]?.[2]).toMatchObject({
    cwd: root,
    input: 'Explain this exact snapshot without tools.',
    loginShell: true,
  })
  expect(f.exec.mock.calls[0]?.[1]).toEqual([
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
    }),
  ).rejects.toThrow(/cannot explain architecture/)
  expect(f.exec).not.toHaveBeenCalled()
})

it('surfaces stdout detail when the process fails with empty stderr', async () => {
  const f = fixture('claude-code')
  f.exec.mockResolvedValue({
    stdout: 'Not logged in · Please run /login',
    stderr: '',
    code: 1,
    signal: null,
  })
  await expect(
    f.model.generate(f.host, {
      projectRoot: root,
      workspaceRoot: root,
      profileId: f.selected.id,
      launchRevision: f.selected.launchRevision,
      prompt: 'Explain this exact snapshot without tools.',
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/Not logged in/)
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
    }),
  ).rejects.toThrow(/default executable.*no custom arguments/)
  expect(f.exec).not.toHaveBeenCalled()
})
