import { describe, expect, it } from 'vitest'
import { asHostId, hostPath, localPath } from '../src/shared'
import {
  ArchitectureReviewPanelStateSession,
  type ArchitectureReviewPanelState,
} from '../src/renderer/src/architecture-review/architecture-review-panel-state'

describe('architecture review panel state session', () => {
  it('remembers explanation collapse independently by host-qualified project', () => {
    const session = new ArchitectureReviewPanelStateSession()
    const local = localPath('/srv/app')
    const remote = hostPath(asHostId('build-host'), '/srv/app')
    const collapsed: ArchitectureReviewPanelState = { explanationCollapsed: true }

    session.write(local, collapsed)

    expect(session.read(local)).toEqual(collapsed)
    expect(session.read(remote)).toEqual({ explanationCollapsed: false })
  })
})
