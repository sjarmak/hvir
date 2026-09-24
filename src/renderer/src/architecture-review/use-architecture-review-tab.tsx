import { useCallback, useState, type RefObject } from 'react'
import { hostPathEquals, type HostPath } from '../../../shared'
import { ArchitectureReview } from './ArchitectureReview'

/** A workspace-qualified native review tab; file tabs retain their document owner. */
export function useArchitectureReviewTab(ports: {
  readonly root: RefObject<HostPath | undefined>
  readonly activateViewer: () => void
}) {
  const [tab, setTab] = useState<{ readonly root: HostPath; readonly active: boolean }>()
  const deactivate = useCallback(
    () => setTab((current) => (current ? { ...current, active: false } : current)),
    [],
  )
  const close = useCallback(() => setTab(undefined), [])
  const open = () => {
    if (!ports.root.current) return
    ports.activateViewer()
    setTab({ root: ports.root.current, active: true })
  }
  const belongs = (root: HostPath, pane = 'primary') =>
    pane === 'primary' && tab !== undefined && hostPathEquals(tab.root, root)
  const active = (root: HostPath, pane = 'primary') =>
    belongs(root, pane) && tab?.active === true
  return {
    open,
    close,
    deactivate,
    active,
    stripProps: (root: HostPath, pane: string) => ({
      architectureReviewOpen: belongs(root, pane),
      architectureReviewActive: active(root, pane),
      onActivateArchitectureReview: open,
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
            onHandoff={(projectId, workspaceId) =>
              void switchWorkspace(projectId, workspaceId)
            }
          />
        </div>
      ) : null,
  }
}
