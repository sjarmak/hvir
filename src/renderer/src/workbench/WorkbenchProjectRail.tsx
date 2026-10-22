import type { ReactElement, ComponentProps, ReactNode } from 'react'
import { GIT_CHANGE_DISPLAY_LIMIT } from '../../../shared'
import { FileTree } from '../tree/FileTree'
import { GitPanel } from '../git/GitPanel'
import { ExtensionLeftRail } from '../extensions/ExtensionContributions'
import type { WorkbenchRailMode } from './use-workbench-layout'
export function WorkbenchProjectRail({
  files,
  git,
  mode,
  onMode,
  activation,
  gitEnabled,
  changedCount,
  changesLimited,
  visible,
  tabs,
  panels,
}: {
  readonly files: ComponentProps<typeof FileTree>
  readonly git?: ComponentProps<typeof GitPanel>
  readonly mode: WorkbenchRailMode
  readonly onMode: (mode: WorkbenchRailMode) => void
  readonly activation: number
  readonly gitEnabled: boolean
  readonly changedCount: number
  readonly changesLimited?: boolean
  readonly visible: boolean
  readonly tabs?: ReactNode
  readonly panels?: ReactNode
}): ReactElement {
  const changedLabel =
    changedCount > 0
      ? changesLimited
        ? `${GIT_CHANGE_DISPLAY_LIMIT.toLocaleString()}+`
        : changedCount.toLocaleString()
      : undefined
  return (
    <aside
      className="tree-panel hvir-panel"
      aria-label="Project rail"
      data-diagnostic-capture="project-navigation"
      tabIndex={-1}
    >
      <ExtensionLeftRail visible={visible} builtinActivation={activation}>
        <nav className="rail-nav" aria-label="Project views">
          <button
            type="button"
            className={(mode === 'files' ? 'active' : '') + ' hvir-button'}
            aria-current={mode === 'files' ? 'page' : undefined}
            onClick={() => onMode('files')}
          >
            Files
          </button>
          {gitEnabled ? (
            <button
              type="button"
              className={(mode === 'git' ? 'active' : '') + ' hvir-button'}
              aria-current={mode === 'git' ? 'page' : undefined}
              onClick={() => onMode('git')}
            >
              Git{changedLabel ? ` ${changedLabel}` : ''}
            </button>
          ) : null}
          {tabs}
        </nav>
        <div className="rail-content">
          <FileTree key={`files:${files.root.hostId}:${files.root.path}`} {...files} />
          {git ? (
            <GitPanel key={`git:${git.root.hostId}:${git.root.path}`} {...git} />
          ) : null}
          {panels}
        </div>
      </ExtensionLeftRail>
    </aside>
  )
}
