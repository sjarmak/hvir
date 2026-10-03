import { describe, expect, it, vi } from 'vitest'

import { ReviewCheckpointHost } from '../src/main/git/review-checkpoint-host'
import type { ProjectHost } from '../src/main/project-host'
import { localPath } from '../src/shared'

describe('review checkpoint untrusted request grammar', () => {
  it('rejects an unknown host action and revokes its grant', async () => {
    const root = localPath('/repo')
    const exec = vi.fn()
    const host = {
      hostId: root.hostId,
      connectionState: 'connected',
      realpath: vi.fn().mockResolvedValue(root),
      exec,
    } as unknown as ProjectHost
    const broker = new ReviewCheckpointHost()
    const authority = { projectId: 'project', root, host }
    const grant = broker.begin(authority, 'read')
    await expect(
      broker.dispatch(grant.id, authority, { action: 'unknown' } as never),
    ).rejects.toThrow('Unsupported')
    await expect(broker.dispatch(grant.id, authority, { action: 'inspect' })).rejects.toThrow()
    expect(exec).not.toHaveBeenCalled()
    broker.dispose()
  })
})
