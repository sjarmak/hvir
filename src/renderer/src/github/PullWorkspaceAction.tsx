import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  hostPathEquals,
  unwrapOperation,
  type HostPath,
  type PullSummary,
  type WorkspaceState,
} from '../../../shared'
import type { PullCheckoutsResponse } from '../../../shared/github'
import {
  canCreatePullWorktree,
  resolvePullWorkspaces,
  type PullWorkspaceNavigation,
} from './pull-workspaces'

interface PullWorkspaceActionProps {
  readonly root: HostPath
  readonly pull: PullSummary
  readonly checkouts: PullCheckoutsResponse | undefined
  readonly repo: string | undefined
  readonly navigation: PullWorkspaceNavigation | undefined
  readonly disabled: boolean
  readonly onCheckouts: (response: PullCheckoutsResponse) => void
}

export function PullWorkspaceAction(props: PullWorkspaceActionProps): ReactElement {
  const { root, pull, checkouts, repo, navigation, disabled, onCheckouts } = props
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const latest = useRef(props)
  const alive = useRef(false)
  const busy = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    latest.current = props
  }, [props])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      generation.current += 1
    }
  }, [])
  useEffect(() => {
    generation.current += 1
  }, [root, disabled])

  const match = resolvePullWorkspaces(pull, checkouts, navigation?.workspaces ?? [])

  async function open(workspace: WorkspaceState): Promise<void> {
    if (busy.current || disabled || !navigation) return
    busy.current = true
    const serial = generation.current
    setPending(true)
    setError(undefined)
    try {
      const fresh = await window.hvir.invoke('github:checkouts', { root })
      if (!alive.current || serial !== generation.current) return
      const current = latest.current
      if (current.disabled || !current.navigation) return
      onCheckouts(fresh)
      if (!fresh.available) throw new Error(fresh.message)
      const verified = resolvePullWorkspaces(
        current.pull,
        fresh,
        current.navigation.workspaces,
      )
      const target =
        verified.status === 'matches'
          ? verified.workspaces.find(
              (candidate) =>
                candidate.id === workspace.id &&
                hostPathEquals(candidate.root, workspace.root),
            )
          : undefined
      if (!target)
        throw new Error(
          'This workspace no longer has a verified checkout for this PR. Refresh the PRs tab.',
        )
      await current.navigation.open(target)
    } catch (reason) {
      if (alive.current && serial === generation.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      busy.current = false
      if (alive.current) setPending(false)
    }
  }

  async function create(): Promise<void> {
    if (busy.current || disabled || !navigation) return
    busy.current = true
    const serial = generation.current
    setPending(true)
    setError(undefined)
    try {
      const state = unwrapOperation(
        await window.hvir.invoke('github:create-worktree', { root, number: pull.number }),
      )
      latest.current.navigation?.acceptProjectState(state)
      const fresh = await window.hvir
        .invoke('github:checkouts', { root })
        .catch((reason: unknown) => {
          throw new Error(
            `Created the worktree, but could not refresh checkouts: ${
              reason instanceof Error ? reason.message : String(reason)
            }. Refresh the PRs tab.`,
          )
        })
      if (!alive.current || serial !== generation.current) return
      latest.current.onCheckouts(fresh)
    } catch (reason) {
      if (alive.current && serial === generation.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      busy.current = false
      if (alive.current) setPending(false)
    }
  }

  function action(workspace: WorkspaceState, showPath = false): ReactElement {
    const current = workspace.id === navigation?.activeWorkspaceId
    const label = current
      ? 'Current workspace'
      : workspace.closed
        ? 'Reopen workspace'
        : 'Open workspace'
    const path = `${workspace.root.hostId}:${workspace.root.path}`
    return current ? (
      <span className="pulls-workspace-note" title={path}>
        {showPath ? `${path} · ${label}` : label}
      </span>
    ) : (
      <button
        type="button"
        className="pulls-workspace-button"
        disabled={disabled || pending}
        title={path}
        aria-label={`${label} for PR #${pull.number}${showPath ? ` at ${path}` : ''}`}
        onClick={() => {
          void open(workspace)
        }}
      >
        {pending
          ? 'Opening…'
          : showPath
            ? `${path}${workspace.closed ? ' · Reopen' : ''}`
            : label}
      </button>
    )
  }

  return (
    <div className="pulls-workspace" aria-busy={pending}>
      <div className="pulls-workspace-line">
        <span
          className="pulls-branch"
          title={pull.headRepo ? `${pull.headRepo}:${pull.headRef}` : pull.headRef}
        >
          {pull.headRef}
        </span>
        {match.status === 'matches' ? (
          match.workspaces.length === 1 ? (
            action(match.workspaces[0]!)
          ) : (
            <details className="pulls-workspace-chooser">
              <summary>Choose workspace…</summary>
              <ul>
                {match.workspaces.map((workspace) => (
                  <li key={workspace.id}>{action(workspace, true)}</li>
                ))}
              </ul>
            </details>
          )
        ) : match.status === 'none' && navigation && canCreatePullWorktree(pull, repo) ? (
          <button
            type="button"
            className="pulls-workspace-button"
            disabled={disabled || pending}
            aria-label={`Create worktree for PR #${pull.number}`}
            onClick={() => {
              void create()
            }}
          >
            {pending ? 'Creating…' : 'Create worktree'}
          </button>
        ) : (
          <span
            className="pulls-workspace-note"
            title={checkouts?.available === false ? checkouts.message : undefined}
          >
            {match.status === 'none' ? 'No checkout' : 'Checkout unverified'}
          </span>
        )}
      </div>
      {error ? (
        <p className="pulls-workspace-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
