import { hostPathEquals, type HostPath, type ProjectState } from '../../../shared'
import type { WebViewState } from './WebPane'

/** Returns a dashboard to the terminal that opened it, switching workspace first. */
export async function revealWebSourceTerminal(
  view: WebViewState,
  ports: {
    readonly projectState?: ProjectState
    readonly root?: HostPath
    readonly switchWorkspace: (projectId: string, workspaceId: string) => Promise<void>
    readonly onError: (message: string) => void
  },
): Promise<void> {
  const target = ports.projectState?.projects
    .flatMap((project) => project.workspaces.map((workspace) => ({ project, workspace })))
    .find(({ workspace }) => hostPathEquals(workspace.root, view.workspaceRoot))
  if (!target) {
    ports.onError('The source workspace is no longer registered')
    return
  }
  if (!ports.root || !hostPathEquals(ports.root, view.workspaceRoot))
    await ports.switchWorkspace(target.project.id, target.workspace.id)
  window.requestAnimationFrame(() => {
    const source = [
      ...document.querySelectorAll<HTMLElement>('[data-terminal-session]'),
    ].find((element) => element.dataset['terminalSession'] === view.sourceTerminalId)
    source?.click()
    source?.focus()
    if (!source) ports.onError('The source terminal has closed')
  })
}
