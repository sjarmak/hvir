import { useEffect, useRef, useState } from 'react'

import type {
  ExternalSessionAttachRequest,
  HostConnectionState,
  HostPath,
  SessionsAttachExternalTarget,
} from '../../../shared'
import type { TerminalAttachRequest } from '../terminal/terminal-workspace-model'
import type { WorkbenchRailMode } from '../workbench/use-workbench-layout'
import { beadCommand, type BeadActionRequest } from './bead-commands'
import { gasCityCommand, type GasCityAction } from './gascity-commands'

export interface BeadsWorkspaceAttach {
  readonly workspaceId: string
  readonly request: TerminalAttachRequest
}

export interface BeadsWorkspace {
  /**
   * Whether the active workspace has a `.beads` project. Starts false and
   * reveals once an async probe confirms, so a plain directory never flashes a
   * Beads tab — mirrors how `gitEnabled` gates the Git tab.
   */
  readonly beadsEnabled: boolean
  /**
   * Whether the active workspace's terminal can open a shell for a typed
   * action right now. False until that workspace reports in, and false again
   * when it has no default harness; the panel disables its actions on it.
   */
  readonly actionsAvailable: boolean
  /**
   * Run a gc action against a crew identity in the active workspace's terminal.
   * `sessionId` is gc's own id for the session, passed when the calling surface
   * knows it: it is what joins the terminal to the session's row exactly.
   */
  readonly requestCrewAction: (
    action: GasCityAction,
    target: string,
    sessionId?: string,
  ) => void
  /**
   * Type a bd write action (claim/close/create) into the active workspace's
   * terminal. Never keyed: every action is one-shot and opens a fresh shell.
   * Resolves true only once the terminal reports the shell launched; false
   * when no workspace is active, nothing can launch, or the command was refused.
   */
  readonly requestBeadAction: (request: BeadActionRequest) => Promise<boolean>
  /**
   * Attach a projected external session in the workspace main just switched to.
   * The ticket names the session; only main can redeem it, because the renderer
   * is never told which session a projected row is (ADR-046).
   */
  readonly requestExternalAttach: (
    workspaceId: string,
    target: SessionsAttachExternalTarget,
  ) => Promise<boolean>
  /** The pending attach request for `workspaceId`, if it targets that workspace. */
  readonly attachRequestFor: (workspaceId: string) => TerminalAttachRequest | undefined
  /** Each workspace terminal reports whether it could launch an attach shell. */
  readonly reportLaunchAvailability: (workspaceId: string, canLaunch: boolean) => void
}

/** The App-workspace context the Beads policy reads — a structural subset. */
interface BeadsWorkspaceContext {
  readonly root?: HostPath
  readonly connectionState: HostConnectionState
  readonly activeWorkspace?: { readonly id: string }
}

/** The rail context the Beads policy reads — a structural subset of the layout. */
interface BeadsRailContext {
  readonly railMode: WorkbenchRailMode
  readonly setRailMode: (mode: WorkbenchRailMode) => void
}

/**
 * Owns the renderer-side Beads workspace policy that App otherwise inlines: the
 * `.beads` probe that gates the Beads tab, the rail fallback when it disappears,
 * and the gc crew actions wired from the Beads panel to a terminal.
 */
export function useBeadsWorkspace(
  session: BeadsWorkspaceContext,
  layout: BeadsRailContext,
): BeadsWorkspace {
  const { root, connectionState, activeWorkspace } = session
  const { railMode, setRailMode } = layout
  const [beadsEnabled, setBeadsEnabled] = useState(false)
  const [attachRequest, setAttachRequest] = useState<BeadsWorkspaceAttach | undefined>()
  const [launchable, setLaunchable] = useState<ReadonlyMap<string, boolean>>(new Map())
  const attachNonce = useRef(0)
  const actionsAvailable =
    activeWorkspace !== undefined && launchable.get(activeWorkspace.id) === true

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
    const workspaceId = activeWorkspace?.id
    if (!workspaceId || launchable.get(workspaceId) !== true) return Promise.resolve(false)
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

  const requestCrewAction = (
    action: GasCityAction,
    target: string,
    sessionId?: string,
  ): void => {
    const { command, key, attaches } = gasCityCommand(action, target, sessionId)
    void requestCommand(command, key, attaches)
  }

  const requestBeadAction = (request: BeadActionRequest): Promise<boolean> => {
    const built = beadCommand(request)
    return built === undefined ? Promise.resolve(false) : requestCommand(built.command)
  }

  // Resolve the pending attach request for one workspace (App maps this over
  // every workspace's terminal, so only the targeted one fires).
  const attachRequestFor = (workspaceId: string): TerminalAttachRequest | undefined =>
    attachRequest?.workspaceId === workspaceId ? attachRequest.request : undefined

  // Probe whether the active workspace has a `.beads` project; drives the Beads
  // tab's visibility. Re-runs on workspace/connection change, with a cancel
  // guard so a slow probe for a previous workspace can't clobber the result.
  useEffect(() => {
    if (!root || connectionState !== 'connected') {
      setBeadsEnabled(false)
      return
    }
    let cancelled = false
    void window.hvir
      .invoke('beads:probe', { root })
      .then((result) => {
        if (!cancelled) setBeadsEnabled(result.hasProject)
      })
      .catch(() => {
        if (!cancelled) setBeadsEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [root, connectionState])

  // The Beads tab can't stay selected once the active workspace has no Beads
  // project; fall back to Files, mirroring the Git-tab gating in the layout hook.
  useEffect(() => {
    if (!beadsEnabled && railMode === 'beads') setRailMode('files')
  }, [beadsEnabled, railMode, setRailMode])

  return {
    beadsEnabled,
    actionsAvailable,
    requestCrewAction,
    requestBeadAction,
    requestExternalAttach,
    attachRequestFor,
    reportLaunchAvailability,
  }
}
