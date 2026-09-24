import { describe, expect, it } from 'vitest'

import {
  GitMutationAuthorization,
  type GitMutationAuthority,
} from '../src/main/git/mutation-authorization'
import {
  hvirWorktreeLocation,
  hvirWorktreeTarget,
  type HvirWorktreeTarget,
} from '../src/main/git/hvir-worktrees'
import type { ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, type HostPath, type WorkerHostCall } from '../src/shared'

type ExecHostCall = Extract<WorkerHostCall, { readonly operation: 'exec' }>

const root = hostPath(asHostId('dev'), '/work/repo')
const otherRoot = hostPath(asHostId('dev'), '/work/other')
const commit = 'a'.repeat(40)
const host = {
  hostId: root.hostId,
  connectionState: 'connected',
} as unknown as ProjectHost
const target = hvirWorktreeTarget(root, 'review-1', commit)

function authority(workspaceRoot: HostPath = root): GitMutationAuthority {
  return { projectId: 'project-1', root: workspaceRoot, host }
}

function addCall(workspaceRoot: HostPath, next: HvirWorktreeTarget): ExecHostCall {
  return {
    kind: 'host-call',
    callId: 1,
    hostId: workspaceRoot.hostId,
    operation: 'exec',
    command: 'git',
    args: [
      '-C',
      workspaceRoot.path,
      'worktree',
      'add',
      '-b',
      next.branch,
      next.path,
      next.commit,
    ],
  }
}

function grant(authorizations: GitMutationAuthorization, next: HvirWorktreeTarget) {
  return authorizations.grant({
    kind: 'worktree-add',
    projectId: 'project-1',
    root,
    target: next,
  })
}

describe('hvir-owned worktree location', () => {
  it('names a sibling directory hvir owns and a branch under hvir/architecture', () => {
    expect(hvirWorktreeLocation(root)).toBe('/work/repo.hvir-worktrees')
    expect(target).toEqual({
      branch: 'hvir/architecture/review-1',
      path: '/work/repo.hvir-worktrees/review-1',
      commit,
    })
  })

  it.each(['', '-x', '../x', 'a/b', 'A', 'x'.repeat(65), 'a b'])(
    'refuses the slug %j',
    (slug) => {
      expect(() => hvirWorktreeTarget(root, slug, commit)).toThrow(
        'Invalid hvir worktree',
      )
    },
  )

  it('refuses a filesystem root and a non-hash commit', () => {
    expect(() =>
      hvirWorktreeTarget(hostPath(root.hostId, '/'), 'review-1', commit),
    ).toThrow('Invalid hvir worktree')
    expect(() => hvirWorktreeTarget(root, 'review-1', 'HEAD')).toThrow(
      'Invalid hvir worktree',
    )
  })
})

describe('worktree-add mutation grants', () => {
  it('consumes one exact grant and returns the exact target as permission', () => {
    const authorizations = new GitMutationAuthorization()
    grant(authorizations, target)

    expect(authorizations.permissionsFor(addCall(root, target), authority())).toEqual({
      allowWorktreeAdd: target,
    })
    expect(() =>
      authorizations.permissionsFor(addCall(root, target), authority()),
    ).toThrow('already consumed')
  })

  it('refuses a grant for an injected branch, an escaping path or a symbolic commit', () => {
    const authorizations = new GitMutationAuthorization()
    const injected = [
      { ...target, branch: '-b' },
      { ...target, branch: 'main' },
      { ...target, branch: 'hvir/architecture/../main' },
      { ...target, branch: 'hvir/architecture/review-2' },
      { ...target, path: '/work/repo.hvir-worktrees/../repo/src' },
      { ...target, path: '/tmp/review-1' },
      { ...target, path: '/work/repo/review-1' },
      { ...target, commit: 'HEAD' },
      { ...target, commit: '--detach' },
    ]
    for (const next of injected)
      expect(() => grant(authorizations, next)).toThrow('Invalid Git mutation target')
  })

  it('denies a call from another workspace or for another target without consuming', () => {
    const authorizations = new GitMutationAuthorization()
    grant(authorizations, target)
    const other = hvirWorktreeTarget(root, 'review-2', commit)

    expect(() =>
      authorizations.permissionsFor(addCall(otherRoot, target), authority()),
    ).toThrow('not an exact workspace')
    expect(() =>
      authorizations.permissionsFor(addCall(otherRoot, target), authority(otherRoot)),
    ).toThrow('no exact grant')
    expect(() =>
      authorizations.permissionsFor(addCall(root, other), authority()),
    ).toThrow('no exact grant')
    expect(authorizations.permissionsFor(addCall(root, target), authority())).toEqual({
      allowWorktreeAdd: target,
    })
  })
})
