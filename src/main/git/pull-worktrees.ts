import type { HostPath } from '../../shared'
import { hvirWorktreeLocation, hvirWorktreeLocationOf } from './hvir-worktrees'

export interface PullWorktreeSource {
  readonly number: number
  readonly branch: string
  readonly remote: string
}

export interface PullWorktreeTarget {
  readonly branch: string
  readonly path: string
  readonly remote: string
}

const MAX_PULL_NUMBER = 1_000_000_000
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const BRANCH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._+@-]*$/
const PULL_DIRECTORY = /^pr-[1-9][0-9]{0,9}$/

export function pullWorktreeTarget(
  root: HostPath,
  number: number,
  branch: string,
  remote: string,
): PullWorktreeTarget {
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_PULL_NUMBER) {
    throw new Error('Invalid pull request number')
  }
  if (!isPullBranch(branch)) throw new Error('Unsupported pull request branch name')
  if (!REMOTE.test(remote)) throw new Error('Unsupported git remote name')
  return { branch, path: `${hvirWorktreeLocation(root)}/pr-${number}`, remote }
}

export function isPullWorktreeTarget(rootPath: string, target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const { branch, path, remote } = target as Record<string, unknown>
  if (
    typeof branch !== 'string' ||
    typeof path !== 'string' ||
    typeof remote !== 'string'
  )
    return false
  const location = hvirWorktreeLocationOf(rootPath)
  return (
    location !== undefined &&
    isPullBranch(branch) &&
    REMOTE.test(remote) &&
    path.startsWith(`${location}/`) &&
    PULL_DIRECTORY.test(path.slice(location.length + 1))
  )
}

export function pullWorktreeStart(target: PullWorktreeTarget): string {
  return `refs/remotes/${target.remote}/${target.branch}`
}

export function pullWorktreeArgs(target: PullWorktreeTarget): readonly string[] {
  return [
    'worktree',
    'add',
    '--track',
    '-b',
    target.branch,
    target.path,
    pullWorktreeStart(target),
  ]
}

export function samePullWorktreeTarget(
  a: PullWorktreeTarget | undefined,
  b: PullWorktreeTarget,
): boolean {
  return (
    a !== undefined && a.branch === b.branch && a.path === b.path && a.remote === b.remote
  )
}

function isPullBranch(branch: string): boolean {
  if (branch.length === 0 || branch.length > 255) return false
  return branch
    .split('/')
    .every(
      (segment) =>
        BRANCH_SEGMENT.test(segment) &&
        !segment.endsWith('.') &&
        !segment.endsWith('.lock') &&
        !segment.includes('..') &&
        !segment.includes('@{'),
    )
}
