import { useRef, useState } from 'react'

import type {
  ExternalSessionAttachRequest,
  SessionsAttachExternalTarget,
} from '../../../shared'
import type { TerminalAttachRequest } from './terminal-workspace-model'

interface WorkspaceAttach {
  readonly workspaceId: string
  readonly request: TerminalAttachRequest
}

/** Commands and external attaches share the terminal's focus-or-launch owner. */
export function useTerminalCommands(activeWorkspaceId?: string) {
  const [attachRequest, setAttachRequest] = useState<WorkspaceAttach | undefined>()
  const [launchable, setLaunchable] = useState<ReadonlyMap<string, boolean>>(new Map())
  const attachNonce = useRef(0)
  const actionsAvailable =
    activeWorkspaceId !== undefined && launchable.get(activeWorkspaceId) === true

  const reportLaunchAvailability = (workspaceId: string, canLaunch: boolean): void => {
    setLaunchable((current) => {
      if (current.get(workspaceId) === canLaunch) return current
      return new Map(current).set(workspaceId, canLaunch)
    })
  }

  // Type a command into the active workspace's terminal. A `key` marks a
  // long-lived identity so a repeat click focuses the terminal already showing
  // it instead of opening another one; one-shot commands pass none. Resolves
  // with the terminal's own answer; a workspace that cannot launch is refused
  // here rather than dispatched to vanish.
  const requestCommand = (
    command: string,
    key?: string,
    attaches?: ExternalSessionAttachRequest,
  ): Promise<boolean> => {
    const workspaceId = activeWorkspaceId
    if (!workspaceId || launchable.get(workspaceId) !== true)
      return Promise.resolve(false)
    return dispatchCommand(workspaceId, command, key, attaches)
  }

  const dispatchCommand = (
    workspaceId: string,
    command: string,
    key?: string,
    attaches?: ExternalSessionAttachRequest,
  ): Promise<boolean> => {
    attachNonce.current += 1
    return new Promise((resolve) => {
      setAttachRequest({
        workspaceId,
        request: {
          command,
          nonce: attachNonce.current,
          onSettled: resolve,
          ...(key === undefined ? {} : { key }),
          ...(attaches === undefined ? {} : { attaches }),
        },
      })
    })
  }

  // The attach targets the workspace main just switched to, whose terminal may
  // not have reported yet. The request waits with that workspace instead of
  // being refused for not having answered in time; it is told either way.
  const requestExternalAttach = (
    workspaceId: string,
    target: SessionsAttachExternalTarget,
  ): Promise<boolean> =>
    dispatchCommand(workspaceId, target.command, target.key, { ticket: target.ticket })

  // Resolve the pending attach request for one workspace (App maps this over
  // every workspace's terminal, so only the targeted one fires).
  const attachRequestFor = (workspaceId: string): TerminalAttachRequest | undefined =>
    attachRequest?.workspaceId === workspaceId ? attachRequest.request : undefined

  return {
    actionsAvailable,
    requestCommand,
    requestExternalAttach,
    attachRequestFor,
    reportLaunchAvailability,
  }
}

export type TerminalCommands = ReturnType<typeof useTerminalCommands>
