import { useEffect, useState } from 'react'

import type { HostConnectionState, HostPath } from '../../../shared'
import type { TerminalCommands } from '../terminal/use-terminal-commands'
import type { WorkbenchRailMode } from '../workbench/use-workbench-layout'
import { beadCommand, type BeadActionRequest } from './bead-commands'
import { gasCityCommand, type GasCityAction } from './gascity-commands'

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
}

/** The App-workspace context the Beads policy reads — a structural subset. */
interface BeadsWorkspaceContext {
  readonly root?: HostPath
  readonly connectionState: HostConnectionState
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
  terminal: Pick<TerminalCommands, 'actionsAvailable' | 'requestCommand'>,
): BeadsWorkspace {
  const { root, connectionState } = session
  const { railMode, setRailMode } = layout
  const [beadsEnabled, setBeadsEnabled] = useState(false)
  const { actionsAvailable, requestCommand } = terminal

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
  }
}
