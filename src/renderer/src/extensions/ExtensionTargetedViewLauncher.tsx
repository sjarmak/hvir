import { useEffect, useRef, type ReactElement } from 'react'
import type { ExtensionView } from '../../../shared/extensions/workbench'
import { useExtensionContributions } from './extension-contribution-context'

export interface ExtensionTargetedViewTarget {
  readonly requestId: string
  readonly extensionId: string
  readonly contributionId: string
  readonly workspaceId: string
  readonly input: unknown
}

export function ExtensionTargetedViewLauncher({
  target,
  onOpened,
  onUnavailable,
}: {
  readonly target?: ExtensionTargetedViewTarget
  readonly onOpened: (requestId: string, view: ExtensionView) => void
  readonly onUnavailable: (requestId: string) => void
}): ReactElement | null {
  const model = useExtensionContributions()
  const state = model?.state
  const stateReady = model?.stateReady
  const targetedInput = model?.targetedInput
  const callbacks = useRef({ onOpened, onUnavailable })
  callbacks.current = { onOpened, onUnavailable }
  const targetKey = JSON.stringify(target)
  useEffect(() => {
    const request = targetKey
      ? (JSON.parse(targetKey) as ExtensionTargetedViewTarget)
      : undefined
    if (!request || !state || !stateReady || !targetedInput) return
    const matches = state.flatMap((installation) =>
      installation.manifest.views
        .filter(
          (view) =>
            installation.manifest.id === request.extensionId &&
            view.id === request.contributionId &&
            view.placement === 'workspace' &&
            view.navigation === 'left',
        )
        .map((view) => ({ installation, view })),
    )
    if (matches.length !== 1) {
      callbacks.current.onUnavailable(request.requestId)
      return
    }
    const match = matches[0]!
    let current = true
    void targetedInput({
        installationId: match.installation.installationId,
        revision: match.installation.revision,
        contributionId: match.view.id,
        workspaceId: request.workspaceId,
        input: request.input,
      })
      .then(
        (view) => {
          if (current) callbacks.current.onOpened(request.requestId, view)
        },
        () => {
          if (current)
            callbacks.current.onUnavailable(request.requestId)
        },
      )
    return () => {
      current = false
    }
  }, [state, stateReady, targetedInput, targetKey])
  return null
}
