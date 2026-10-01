import type { ReactElement } from 'react'

import { BeadsRailPanel, BeadsRailTab, useBeadsWorkspace } from '../beads/BeadsRail'
import { GitHubRailPanel, GitHubRailTab, useGitHubWorkspace } from '../github/GitHubRail'

type RailSession = Parameters<typeof useBeadsWorkspace>[0] &
  Parameters<typeof useGitHubWorkspace>[0]
type RailLayout = Parameters<typeof useBeadsWorkspace>[1] &
  Parameters<typeof useGitHubWorkspace>[1]
type RailTerminal = Parameters<typeof useBeadsWorkspace>[2]

export interface RailExtensions {
  readonly beads: ReturnType<typeof useBeadsWorkspace>
  readonly github: ReturnType<typeof useGitHubWorkspace>
}

export function useRailExtensions(
  session: RailSession,
  layout: RailLayout,
  terminal: RailTerminal,
): RailExtensions {
  return {
    beads: useBeadsWorkspace(session, layout, terminal),
    github: useGitHubWorkspace(session, layout),
  }
}

export function RailTabs({
  rail,
  layout,
}: {
  readonly rail: RailExtensions
  readonly layout: RailLayout
}): ReactElement {
  return (
    <>
      <BeadsRailTab beads={rail.beads} layout={layout} />
      <GitHubRailTab github={rail.github} layout={layout} />
    </>
  )
}

export function RailPanels({
  rail,
  session,
  layout,
}: {
  readonly rail: RailExtensions
  readonly session: RailSession
  readonly layout: RailLayout
}): ReactElement {
  return (
    <>
      <BeadsRailPanel beads={rail.beads} session={session} layout={layout} />
      <GitHubRailPanel github={rail.github} session={session} layout={layout} />
    </>
  )
}
