import { useEffect, useRef, useState } from 'react'

import type { HostConnectionState, HostPath } from '../../../shared'
import type { TerminalAttachRequest } from '../terminal/terminal-workspace-model'
import type { WorkbenchRailMode } from '../workbench/use-workbench-layout'

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
  /** Request a `gc session attach <worker>` terminal in the active workspace. */
  readonly requestAttachWorker: (worker: string) => void
  /** The pending attach request for `workspaceId`, if it targets that workspace. */
  readonly attachRequestFor: (workspaceId: string) => TerminalAttachRequest | undefined
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
 * and the worker-attach request wired from the Beads panel to a terminal.
 */
export function useBeadsWorkspace(
  session: BeadsWorkspaceContext,
  layout: BeadsRailContext,
): BeadsWorkspace {
  const { root, connectionState, activeWorkspace } = session
  const { railMode, setRailMode } = layout
  const [beadsEnabled, setBeadsEnabled] = useState(false)
  const [attachRequest, setAttachRequest] = useState<BeadsWorkspaceAttach | undefined>()
  const attachNonce = useRef(0)

  // Open a terminal running `gc session attach <worker>` in the active
  // workspace when a live worker name is clicked in the Beads panel. The worker
  // id is shell-quoted since it flows into an interactive shell command line.
  const requestAttachWorker = (worker: string): void => {
    const workspaceId = activeWorkspace?.id
    if (!workspaceId) return
    attachNonce.current += 1
    setAttachRequest({
      workspaceId,
      request: {
        command: `gc session attach ${shellQuoteArg(worker)}`,
        nonce: attachNonce.current,
      },
    })
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

  return { beadsEnabled, requestAttachWorker, attachRequestFor }
}

/**
 * POSIX single-quote a value so it is safe to splice into an interactive shell
 * command line. Worker ids are normally plain identifiers, but the value flows
 * into a shell, so quote defensively rather than trusting the input.
 */
function shellQuoteArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
