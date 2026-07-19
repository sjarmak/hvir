import type { ReactElement } from 'react'

import type { HostConnectionState, HostPath } from '../../../shared'
import type { WorkbenchRailMode } from '../workbench/use-workbench-layout'
import { BeadsPanel } from './BeadsPanel'
import type { BeadsWorkspace } from './use-beads-workspace'

export { useBeadsWorkspace, type BeadsWorkspace } from './use-beads-workspace'

/**
 * Self-contained rail integration for the Gas City pane: the nav tab and the
 * panel. The pane is named for what it shows — the rig's crew above its bead
 * queue — while the code, IPC channels, and CSS keep their `beads` names, since
 * the `.beads` project is still what gates the tab. Both take the App
 * `session`/`layout` context objects and gate themselves on the probe result,
 * so App composes them in one line each without inlining the conditionals.
 */

interface BeadsRailContext {
  readonly root?: HostPath
  readonly connectionState: HostConnectionState
}

interface BeadsRailLayout {
  readonly railMode: WorkbenchRailMode
  readonly setRailMode: (mode: WorkbenchRailMode) => void
}

export function BeadsRailTab({
  beads,
  layout,
}: {
  readonly beads: BeadsWorkspace
  readonly layout: BeadsRailLayout
}): ReactElement | null {
  if (!beads.beadsEnabled) return null
  const active = layout.railMode === 'beads'
  return (
    <button
      type="button"
      className={active ? 'active' : ''}
      aria-current={active ? 'page' : undefined}
      onClick={() => layout.setRailMode('beads')}
    >
      Gas City
    </button>
  )
}

export function BeadsRailPanel({
  beads,
  session,
  layout,
}: {
  readonly beads: BeadsWorkspace
  readonly session: BeadsRailContext
  readonly layout: Pick<BeadsRailLayout, 'railMode'>
}): ReactElement | null {
  if (!beads.beadsEnabled || !session.root) return null
  const root = session.root
  return (
    <BeadsPanel
      key={`beads:${root.hostId}:${root.path}`}
      root={root}
      connected={session.connectionState === 'connected'}
      hidden={layout.railMode !== 'beads'}
      onCrewAction={beads.requestCrewAction}
    />
  )
}
