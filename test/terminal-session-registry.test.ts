import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import { TerminalSessionRegistry } from '../src/main/terminal/session-registry'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asHostId,
  hostPath,
  localPath,
} from '../src/shared'

const SESSION_ID = 'terminal-1'
const HARNESS_ID = '019ab123-4567-7890-abcd-ef0123456789'
const SHELL_PROVIDER_ID = asHarnessProviderId('plain-shell')
const CLAUDE_PROVIDER_ID = asHarnessProviderId('claude-code')
const CODEX_PROVIDER_ID = asHarnessProviderId('codex')
const SHELL_PROFILE_ID = asHarnessProfileId('plain-shell-default')
const CLAUDE_PROFILE_ID = asHarnessProfileId('claude-code-default')
const CODEX_PROFILE_ID = asHarnessProfileId('codex-default')

describe('TerminalSessionRegistry', () => {
  let directory: string
  let host: LocalHost
  let file: ReturnType<typeof localPath>
  let registry: TerminalSessionRegistry

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-terminal-registry-'))
    host = new LocalHost()
    await host.connect()
    file = localPath(join(directory, 'terminal-sessions.json'))
    registry = await TerminalSessionRegistry.load(host, file)
  })

  afterEach(async () => {
    await registry.flush().catch(() => undefined)
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('persists an exact discovered identity with its rail position and title', async () => {
    const root = localPath('/tmp/project')
    const listener = vi.fn()
    const release = registry.observe(listener)
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })
    await registry.recordIdentity(SESSION_ID, HARNESS_ID)
    await registry.updateLayout(root, [
      {
        id: SESSION_ID,
        title: 'Review recovery flow',
        position: 2,
        active: true,
        attention: 'bell',
      },
    ])
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Review recovery flow',
      position: 2,
      active: true,
    })
    await registry.flush()

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        recoverySkipCount: 0,
        harnessSessionId: HARNESS_ID,
        cwd: root,
        title: 'Review recovery flow',
        position: 2,
        active: true,
        attention: 'bell',
      }),
    ])
    expect(listener).toHaveBeenCalled()
    expect(registry.observationSnapshot()).toEqual([
      expect.objectContaining({ id: SESSION_ID, workspaceRoot: root }),
    ])
    await release()
  })

  it('renames a retained record, pins it, and survives a reload', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: SHELL_PROVIDER_ID,
      profileId: SHELL_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
      cwd: root,
      title: 'dev@workstation: ~/projects/mem',
      position: 0,
      active: true,
    })

    await registry.rename(root, SESSION_ID, 'Beads Dolt server unreachable')
    expect(registry.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        title: 'Beads Dolt server unreachable',
        titlePinned: true,
      }),
    ])

    // A later OSC-driven layout sync must not clobber the pinned rename.
    await registry.updateLayout(root, [
      { id: SESSION_ID, title: 'dev@workstation: ~/projects/mem', position: 0, active: true },
    ])
    expect(registry.list(root)).toEqual([
      expect.objectContaining({
        title: 'dev@workstation: ~/projects/mem',
        titlePinned: false,
      }),
    ])

    await registry.updateLayout(root, [
      {
        id: SESSION_ID,
        title: 'Beads Dolt server unreachable',
        titlePinned: true,
        position: 0,
        active: true,
      },
    ])
    await registry.flush()

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({
        title: 'Beads Dolt server unreachable',
        titlePinned: true,
      }),
    ])
  })

  it('rejects renaming a session that belongs to another workspace', async () => {
    const root = localPath('/tmp/project')
    const otherRoot = localPath('/tmp/other-project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: SHELL_PROVIDER_ID,
      profileId: SHELL_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
      cwd: root,
      title: 'Terminal',
      position: 0,
      active: true,
    })

    await expect(
      registry.rename(otherRoot, SESSION_ID, 'Renamed'),
    ).rejects.toThrow('no longer belongs to the workspace')
    expect(registry.list(root)).toEqual([expect.objectContaining({ title: 'Terminal' })])
  })

  it.each([
    ['local', localPath('/tmp/project')],
    ['SSH', hostPath(asHostId('ssh-recovery-skips'), '/srv/project')],
  ])(
    'persists consecutive recovery decisions and prunes only hvir metadata for %s records',
    async (_kind, root) => {
      const secondId = 'terminal-2'
      for (const [id, position] of [
        [SESSION_ID, 0],
        [secondId, 1],
      ] as const) {
        await registry.recordSpawn({
          id,
          providerId: CLAUDE_PROVIDER_ID,
          profileId: CLAUDE_PROFILE_ID,
          launchRevision: 1,
          harnessSessionId: `${HARNESS_ID}-${position}`,
          workspaceRoot: root,
          cwd: root,
          title: `Claude ${position + 1}`,
          position,
          active: position === 0,
        })
      }

      await registry.recordRecoveryDecision(root, {
        restoredIds: [],
        skippedIds: [SESSION_ID, secondId],
      })
      let restored = await TerminalSessionRegistry.load(host, file)
      expect(restored.list(root)).toEqual([
        expect.objectContaining({ id: SESSION_ID, recoverySkipCount: 1 }),
        expect.objectContaining({ id: secondId, recoverySkipCount: 1 }),
      ])

      await restored.recordRecoveryDecision(root, {
        restoredIds: [SESSION_ID],
        skippedIds: [secondId],
      })
      expect(restored.list(root)).toEqual([
        expect.objectContaining({ id: SESSION_ID, recoverySkipCount: 0 }),
      ])

      await restored.recordRecoveryDecision(root, {
        restoredIds: [],
        skippedIds: [SESSION_ID],
      })
      await restored.recordRecoveryDecision(root, {
        restoredIds: [SESSION_ID],
        skippedIds: [],
      })
      expect(restored.list(root)[0]).toEqual(
        expect.objectContaining({ id: SESSION_ID, recoverySkipCount: 0 }),
      )

      await restored.recordRecoveryDecision(root, {
        restoredIds: [],
        skippedIds: [SESSION_ID],
      })
      restored = await TerminalSessionRegistry.load(host, file)
      expect(restored.list(root)[0]).toEqual(
        expect.objectContaining({ id: SESSION_ID, recoverySkipCount: 1 }),
      )
      await restored.recordRecoveryDecision(root, {
        restoredIds: [],
        skippedIds: [SESSION_ID],
      })
      expect(restored.list(root)).toEqual([])
      expect(await host.readTextFile(file)).not.toContain(HARNESS_ID)
    },
  )

  it('rolls back a recovery decision when metadata persistence fails', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })
    vi.spyOn(host, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(
      registry.recordRecoveryDecision(root, {
        restoredIds: [],
        skippedIds: [SESSION_ID],
      }),
    ).rejects.toThrow('disk unavailable')
    expect(registry.list(root)[0]).toEqual(
      expect.objectContaining({ id: SESSION_ID, recoverySkipCount: 0 }),
    )
    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)[0]).toEqual(
      expect.objectContaining({ id: SESSION_ID, recoverySkipCount: 0 }),
    )
  })

  it('retains provisional harness layout without authorizing resume', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })
    await registry.flush()

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: undefined,
        title: 'Codex · project',
      }),
    ])
    expect(
      restored.authorizeResume({
        id: SESSION_ID,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(false)
  })

  it('persists plain shell layout without claiming resumable process state', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: SHELL_PROVIDER_ID,
      profileId: SHELL_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
      cwd: root,
      title: 'Shell · project',
      position: 1,
      active: false,
    })
    await registry.flush()

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        providerId: SHELL_PROVIDER_ID,
        profileId: SHELL_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: undefined,
        title: 'Shell · project',
        position: 1,
        active: false,
      }),
    ])
  })

  it('reconciles identity discovery that wins the spawn-persistence race', async () => {
    const root = localPath('/tmp/project')
    const identityAccepted = registry.recordIdentity(SESSION_ID, HARNESS_ID)
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })
    await expect(identityAccepted).resolves.toBe(true)

    expect(registry.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        harnessSessionId: HARNESS_ID,
      }),
    ])
  })

  it('rejects a pending identity that differs from the spawn identity', async () => {
    const root = localPath('/tmp/project')
    const spawnHarnessId = '019ab123-4567-7890-abcd-ef0123456790'
    const identityAccepted = registry.recordIdentity(SESSION_ID, HARNESS_ID)

    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: spawnHarnessId,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })

    await expect(identityAccepted).resolves.toBe(false)
    expect(registry.get(SESSION_ID)?.harnessSessionId).toBe(spawnHarnessId)
  })

  it('retains a failed spawn write so later identity registration can recover', async () => {
    const root = localPath('/tmp/project')
    const identityAccepted = registry.recordIdentity(SESSION_ID, HARNESS_ID)
    vi.spyOn(host, 'writeFile').mockRejectedValueOnce(new Error('spawn write failed'))

    await expect(
      registry.recordSpawn({
        id: SESSION_ID,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        workspaceRoot: root,
        cwd: root,
        title: 'Codex · project',
        position: 0,
        active: true,
      }),
    ).rejects.toThrow('spawn write failed')

    await expect(identityAccepted).resolves.toBe(false)
    expect(registry.get(SESSION_ID)).toMatchObject({
      id: SESSION_ID,
      harnessSessionId: undefined,
    })
    await expect(registry.recordIdentity(SESSION_ID, HARNESS_ID)).resolves.toBe(true)

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.get(SESSION_ID)?.harnessSessionId).toBe(HARNESS_ID)
  })

  it('does not resurrect a session closed while spawn persistence is pending', async () => {
    const root = localPath('/tmp/project')
    const identityAccepted = registry.recordIdentity(SESSION_ID, HARNESS_ID)
    await registry.forget(root, SESSION_ID)
    await expect(identityAccepted).resolves.toBe(false)
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })

    expect(registry.list(root)).toEqual([])
  })

  it('authorizes only the stored project, cwd, provider, and harness id', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Claude Code · project',
      position: 0,
      active: true,
    })

    expect(
      registry.authorizeResume({
        id: SESSION_ID,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(true)
    expect(
      registry.authorizeResume({
        id: SESSION_ID,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: localPath('/tmp/other'),
        cwd: root,
      }),
    ).toBe(false)
    await registry.forget(root, SESSION_ID)
    expect(registry.list(root)).toEqual([])
  })

  it('authorizes renderer reattachment for an exact stored terminal identity', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: SHELL_PROVIDER_ID,
      profileId: SHELL_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
      cwd: root,
      title: 'Shell',
      position: 0,
      active: true,
    })

    expect(
      registry.authorizeReattach({
        id: SESSION_ID,
        providerId: SHELL_PROVIDER_ID,
        profileId: SHELL_PROFILE_ID,
        launchRevision: 1,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(true)
    expect(
      registry.authorizeReattach({
        id: SESSION_ID,
        providerId: SHELL_PROVIDER_ID,
        profileId: SHELL_PROFILE_ID,
        launchRevision: 2,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(false)
    expect(
      registry.authorizeReattach({
        id: SESSION_ID,
        providerId: SHELL_PROVIDER_ID,
        profileId: SHELL_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(false)
  })

  it('atomically replaces a retained recovery record with new identities', async () => {
    const root = localPath('/tmp/project')
    const replacementId = 'terminal-2'
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Retained conversation',
      position: 2,
      active: true,
    })

    expect(
      registry.authorizeReplacement({
        replacedId: SESSION_ID,
        replacementId,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(true)
    await registry.recordReplacement({
      replacedId: SESSION_ID,
      spawn: {
        id: replacementId,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: replacementId,
        workspaceRoot: root,
        cwd: root,
        title: 'Retained conversation',
        position: 2,
        active: true,
      },
    })

    expect(registry.list(root)).toEqual([
      expect.objectContaining({
        id: replacementId,
        harnessSessionId: replacementId,
        position: 2,
        active: true,
      }),
    ])
    await registry.recordIdentity(SESSION_ID, HARNESS_ID)
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Late source callback',
      position: 0,
      active: false,
    })
    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({ id: replacementId, harnessSessionId: replacementId }),
    ])
  })

  it('consumes a discovered replacement identity that arrives before commit', async () => {
    const root = localPath('/tmp/project')
    const replacementId = 'terminal-2'
    const replacementHarnessId = '019ab123-4567-7890-abcd-ef0123456790'
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })
    const identityAccepted = registry.recordIdentity(replacementId, replacementHarnessId)

    await registry.recordReplacement({
      replacedId: SESSION_ID,
      spawn: {
        id: replacementId,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        workspaceRoot: root,
        cwd: root,
        title: 'Codex · project',
        position: 0,
        active: true,
      },
    })
    await expect(identityAccepted).resolves.toBe(true)

    expect(registry.list(root)).toEqual([
      expect.objectContaining({
        id: replacementId,
        harnessSessionId: replacementHarnessId,
      }),
    ])
  })

  it('rejects a pending identity that differs from the replacement identity', async () => {
    const root = localPath('/tmp/project')
    const replacementId = 'terminal-2'
    const pendingHarnessId = '019ab123-4567-7890-abcd-ef0123456790'
    const replacementHarnessId = '019ab123-4567-7890-abcd-ef0123456791'
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })
    const identityAccepted = registry.recordIdentity(replacementId, pendingHarnessId)

    await registry.recordReplacement({
      replacedId: SESSION_ID,
      spawn: {
        id: replacementId,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: replacementHarnessId,
        workspaceRoot: root,
        cwd: root,
        title: 'Codex · project',
        position: 0,
        active: true,
      },
    })

    await expect(identityAccepted).resolves.toBe(false)
    expect(registry.get(replacementId)?.harnessSessionId).toBe(replacementHarnessId)
  })

  it('rolls a replacement back when its durable commit fails', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Retained conversation',
      position: 0,
      active: true,
    })
    vi.spyOn(host, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(
      registry.recordReplacement({
        replacedId: SESSION_ID,
        spawn: {
          id: 'terminal-2',
          providerId: CLAUDE_PROVIDER_ID,
          profileId: CLAUDE_PROFILE_ID,
          launchRevision: 1,
          harnessSessionId: 'terminal-2',
          workspaceRoot: root,
          cwd: root,
          title: 'Retained conversation',
          position: 0,
          active: true,
        },
      }),
    ).rejects.toThrow('disk unavailable')

    expect(registry.list(root)).toEqual([
      expect.objectContaining({ id: SESSION_ID, harnessSessionId: HARNESS_ID }),
    ])
    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({ id: SESSION_ID, harnessSessionId: HARNESS_ID }),
    ])
  })

  it('does not commit a replacement cancelled while persistence is pending', async () => {
    const root = localPath('/tmp/project')
    const replacementId = 'terminal-2'
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Retained conversation',
      position: 0,
      active: true,
    })
    let releaseWrite: (() => void) | undefined
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const write = vi.spyOn(host, 'writeFile').mockReturnValueOnce(pendingWrite)
    const replacement = registry.recordReplacement({
      replacedId: SESSION_ID,
      spawn: {
        id: replacementId,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: replacementId,
        workspaceRoot: root,
        cwd: root,
        title: 'Retained conversation',
        position: 0,
        active: true,
      },
    })
    await vi.waitFor(() => expect(write).toHaveBeenCalled())

    const forgetReplacement = registry.forget(root, replacementId)
    const forgetSource = registry.forget(root, SESSION_ID)
    releaseWrite?.()

    await expect(replacement).rejects.toThrow('cancelled')
    await Promise.all([forgetReplacement, forgetSource])
    expect(registry.list(root)).toEqual([])
    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([])
  })

})
