import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  claimArchitectureAgentLaunch,
  queueArchitectureAgentLaunch,
} from '../src/renderer/src/architecture-review/architecture-review-launch'
import { dispatchBeadCommand } from '../src/renderer/src/beads/bead-launch-event'

const root = { hostId: 'local', path: '/repo' } as never
const worktree = { hostId: 'local', path: '/repo.hvir-worktrees/review-1' } as never
const launch = { handoffId: 'handoff-1', root: worktree, digest: 'digest' } as never

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('architecture review renderer handoff', () => {
  it('carries one queued launch across the switch to the worktree that claims it', () => {
    const target = new EventTarget()
    ;(globalThis as { window: EventTarget }).window = target
    const announced = vi.fn()
    target.addEventListener('hvir:architecture-agent-launch-queued', announced)
    queueArchitectureAgentLaunch({
      launch,
      profileId: 'codex' as never,
      launchRevision: 1,
    })
    expect(announced).toHaveBeenCalledOnce()
    expect(claimArchitectureAgentLaunch(root, () => true)).toBeUndefined()
    expect(claimArchitectureAgentLaunch(worktree, () => undefined)).toBeUndefined()
    const attempt = vi.fn(() => true)
    expect(claimArchitectureAgentLaunch(worktree, attempt)).toBe(true)
    expect(attempt).toHaveBeenCalledWith({
      launch,
      profileId: 'codex',
      launchRevision: 1,
    })
    expect(claimArchitectureAgentLaunch(worktree, attempt)).toBeUndefined()
    expect(attempt).toHaveBeenCalledOnce()
  })

  it('settles a refused launch so it never retries', () => {
    ;(globalThis as { window: EventTarget }).window = new EventTarget()
    queueArchitectureAgentLaunch({
      launch,
      profileId: 'codex' as never,
      launchRevision: 1,
    })
    expect(claimArchitectureAgentLaunch(worktree, () => false)).toBe(false)
    expect(claimArchitectureAgentLaunch(worktree, () => true)).toBeUndefined()
  })

  it('routes accepted findings to the native Beads command owner', async () => {
    const target = new EventTarget()
    ;(globalThis as { window: EventTarget }).window = target
    target.addEventListener('hvir:bead-command', (event) => {
      ;(event as CustomEvent<{ resolve: (accepted: boolean) => void }>).detail.resolve(
        true,
      )
    })
    expect(await dispatchBeadCommand(root, 'bd create --title finding')).toBe(true)
  })
})
