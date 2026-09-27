import { describe, expect, it } from 'vitest'
import { asHostId, hostPath, localPath } from '../src/shared'
import { ArchitectureExplanationStateSession } from '../src/renderer/src/architecture-review/architecture-explanation-state'

describe('architecture explanation state session', () => {
  it('remembers collapse independently by host-qualified project', () => {
    const session = new ArchitectureExplanationStateSession()
    const local = localPath('/srv/app')
    const remote = hostPath(asHostId('build-host'), '/srv/app')

    session.write(local, true)

    expect(session.read(local)).toBe(true)
    expect(session.read(remote)).toBe(false)
  })
})
