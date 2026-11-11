import type { ReactElement } from 'react'

import { GitHubRailPanel, GitHubRailTab, useGitHubWorkspace } from '../github/GitHubRail'

type RailSession = Parameters<typeof useGitHubWorkspace>[0]
type RailLayout = Parameters<typeof useGitHubWorkspace>[1]

export interface RailExtensions {
  readonly github: ReturnType<typeof useGitHubWorkspace>
}

export function useRailExtensions(
  session: RailSession,
  layout: RailLayout,
): RailExtensions {
  return {
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
  return <GitHubRailPanel github={rail.github} session={session} layout={layout} />
}
