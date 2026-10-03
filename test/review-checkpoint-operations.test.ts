import { describe, expect, it, vi } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import { localPath } from '../src/shared'
import { ReviewCheckpointOperations } from '../src/main/git/review-checkpoint-operations'

const scope = { projectId: 'project', root: localPath('/repo') }

describe('review checkpoint operation authority', () => {
  it('permits bounded capture effects and exactly one terminal ref write', async () => {
    const operations = new ReviewCheckpointOperations()
    const grant = operations.begin(scope, 'capture')
    await operations.run(grant.id, scope, (lease) => {
      lease.charge({ files: 1, bytes: 4 })
      lease.assertCapture()
    })
    await operations.run(grant.id, scope, (lease) => lease.finishRef())
    await expect(operations.run(grant.id, scope, async () => {})).rejects.toThrow()
    grant.revoke()
    operations.dispose()
  })

  it('read grants never acquire write authority, for any attempted sequence', async () => {
    await hegel.testAsync(async (tc) => {
      const writes = tc.draw(gs.arrays(gs.booleans(), { maxSize: 20 }))
      const operations = new ReviewCheckpointOperations()
      const grant = operations.begin(scope, 'read')
      try {
        for (const finish of writes) {
          await expect(
            operations.run(grant.id, scope, (lease) => {
              if (finish) lease.finishRef()
              else lease.assertCapture()
            }),
          ).rejects.toThrow()
        }
      } finally {
        operations.dispose()
      }
    })
  })

  it('rejects absent, wrong-project and wrong-root authority before effects', async () => {
    const operations = new ReviewCheckpointOperations()
    const grant = operations.begin(scope, 'capture')
    const effect = vi.fn(async () => {})
    for (const candidate of [
      { ...scope, projectId: 'other' },
      { ...scope, root: localPath('/repo/child') },
    ]) {
      await expect(operations.run(grant.id, candidate, effect)).rejects.toThrow()
    }
    await expect(operations.run('unknown', scope, effect)).rejects.toThrow()
    expect(effect).not.toHaveBeenCalled()
    operations.dispose()
  })

  it('serializes workspace mutation grants and rejects overlapping host calls', async () => {
    const operations = new ReviewCheckpointOperations()
    const grant = operations.begin(scope, 'capture')
    expect(() => operations.begin(scope, 'clear')).toThrow('already active')
    let release!: () => void
    const pending = operations.run(
      grant.id,
      scope,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await expect(operations.run(grant.id, scope, async () => {})).rejects.toThrow(
      'in flight',
    )
    release()
    await pending
    operations.dispose()
  })

  it('revocation aborts outstanding effects and rejects their late completion', async () => {
    const operations = new ReviewCheckpointOperations()
    const grant = operations.begin(scope, 'capture')
    let release!: () => void
    const pending = operations.run(grant.id, scope, (lease) => {
      expect(lease.signal.aborted).toBe(false)
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    grant.revoke()
    expect(grant.signal.aborted).toBe(true)
    release()
    await expect(pending).rejects.toThrow()
    expect(() => operations.begin(scope, 'clear')).not.toThrow()
    operations.dispose()
  })

  it('enforces per-operation bytes, files and trees without partial permission', async () => {
    for (const cost of [
      { bytes: 257 * 1024 * 1024 },
      { files: 10_001 },
      { trees: 10_001 },
      { bytes: -1 },
      { files: NaN },
    ]) {
      const operations = new ReviewCheckpointOperations()
      const grant = operations.begin(scope, 'capture')
      await expect(
        operations.run(grant.id, scope, (lease) => lease.charge(cost)),
      ).rejects.toThrow()
      expect(grant.signal.aborted).toBe(true)
      operations.dispose()
    }
  })

  it('expiry and disposal revoke grants and prevent new effects', async () => {
    vi.useFakeTimers()
    try {
      const operations = new ReviewCheckpointOperations()
      const grant = operations.begin(scope, 'capture')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(grant.signal.aborted).toBe(true)
      await expect(operations.run(grant.id, scope, async () => {})).rejects.toThrow()
      operations.dispose()
      expect(() => operations.begin(scope, 'read')).toThrow('disposed')
    } finally {
      vi.useRealTimers()
    }
  })
})
