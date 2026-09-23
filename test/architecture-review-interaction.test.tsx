import { afterEach, describe, expect, it } from 'vitest'

import { dispatchArchitectureReviewLaunch } from '../src/renderer/src/architecture-review/architecture-review-launch'
import { dispatchBeadCommand } from '../src/renderer/src/beads/bead-launch-event'

const root = { hostId: 'local', path: '/repo' } as never
const launch = { root, reviewId: 'review', snapshotId: 'snapshot', path: { hostId: 'local', path: '/repo/src/a.ts' }, digest: 'digest' } as never

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('architecture review renderer handoff', () => {
  it('refuses immediately when no terminal workspace claims launch', async () => {
    const target = new EventTarget()
    ;(globalThis as { window: EventTarget }).window = target
    expect(await dispatchArchitectureReviewLaunch({ root, launch, profileId: 'codex' as never, launchRevision: 1 })).toBe(false)
  })

  it('routes accepted findings to the native Beads command owner', async () => {
    const target = new EventTarget()
    ;(globalThis as { window: EventTarget }).window = target
    target.addEventListener('hvir:bead-command', (event) => {
      ;(event as CustomEvent<{ resolve: (accepted: boolean) => void }>).detail.resolve(true)
    })
    expect(await dispatchBeadCommand(root, 'bd create --title finding')).toBe(true)
  })
})
