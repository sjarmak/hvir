import { useCallback, useRef, useState, type RefObject } from 'react'
import { hostPathEquals, type HostPath } from '../../../shared'
import { ArchitectureReview, type ArchitectureEndsRequest } from './ArchitectureReview'
import type {
  ArchitectureCommitDescriptions,
  ArchitectureEnds,
  StripStepping,
} from './architecture-ends-model'
import { ArchitectureExplanationStateSession } from './architecture-explanation-state'

/** A workspace-qualified native review tab; file tabs retain their document owner. */
export function useArchitectureReviewTab(ports: {
  readonly root: RefObject<HostPath | undefined>
  readonly activateViewer: () => void
}) {
  const explanationStateSession = useRef<ArchitectureExplanationStateSession>(undefined)
  if (!explanationStateSession.current) {
    explanationStateSession.current = new ArchitectureExplanationStateSession()
  }
  const [tab, setTab] = useState<{
    readonly root: HostPath
    readonly active: boolean
    readonly request?: ArchitectureEndsRequest
  }>()
  const requests = useRef(0)
  const deactivate = useCallback(
    () => setTab((current) => (current ? { ...current, active: false } : current)),
    [],
  )
  const close = useCallback(() => setTab(undefined), [])
  const open = (
    ends?: ArchitectureEnds,
    described?: ArchitectureCommitDescriptions,
    stepping?: StripStepping,
  ) => {
    if (!ports.root.current) return
    ports.activateViewer()
    const root = ports.root.current
    setTab((current) => ({
      root,
      active: true,
      request:
        ends === undefined
          ? current && hostPathEquals(current.root, root)
            ? current.request
            : undefined
          : { ends, serial: ++requests.current, described, stepping },
    }))
  }
  const belongs = (root: HostPath, pane = 'primary') =>
    pane === 'primary' && tab !== undefined && hostPathEquals(tab.root, root)
  const active = (root: HostPath, pane = 'primary') =>
    belongs(root, pane) && tab?.active === true
  const handlesPointerActivation = (root: HostPath, pane = 'primary') =>
    active(root, pane)
  return {
    open,
    close,
    deactivate,
    active,
    handlesPointerActivation,
    stripProps: (root: HostPath, pane: string) => ({
      architectureReviewOpen: belongs(root, pane),
      architectureReviewActive: active(root, pane),
      onActivateArchitectureReview: () => open(),
      onCloseArchitectureReview: close,
    }),
    panel: (
      root: HostPath,
      pane: string,
      switchWorkspace: (projectId: string, workspaceId: string) => Promise<void>,
    ) =>
      belongs(root, pane) ? (
        <div className="workspace-view" hidden={!active(root, pane)}>
          <ArchitectureReview
            key={JSON.stringify(root)}
            root={root}
            active={active(root, pane)}
            request={tab?.request}
            explanationStateSession={explanationStateSession.current}
            onHandoff={(projectId, workspaceId) =>
              void switchWorkspace(projectId, workspaceId)
            }
          />
        </div>
      ) : null,
  }
}
