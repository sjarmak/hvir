import { posix } from 'node:path'
import type { HostPath } from '../../shared'

/**
 * The one place hvir creates a worktree (ADR-063): a sibling directory named after the
 * registered root, one directory per handoff, on a fresh branch under
 * `hvir/architecture/`. Every name is derived here, so a grant, the broker and the
 * coordinator compare one exact spelling rather than re-deriving it.
 */
export const HVIR_ARCHITECTURE_BRANCH_PREFIX = 'hvir/architecture/'

export interface HvirWorktreeTarget {
  readonly branch: string
  /** Absolute path on the project host, under hvirWorktreeLocation(root). */
  readonly path: string
  /** The full commit the new branch starts at. */
  readonly commit: string
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

/** The directory hvir owns beside a registered root; refuses a root with no parent. */
export function hvirWorktreeLocation(root: HostPath): string {
  const location = locationOf(root.path)
  if (!location) throw new Error('Invalid hvir worktree root')
  return location
}

export function hvirWorktreeTarget(
  root: HostPath,
  slug: string,
  commit: string,
): HvirWorktreeTarget {
  if (!SLUG.test(slug)) throw new Error('Invalid hvir worktree name')
  if (!COMMIT.test(commit)) throw new Error('Invalid hvir worktree commit')
  const location = hvirWorktreeLocation(root)
  return {
    branch: `${HVIR_ARCHITECTURE_BRANCH_PREFIX}${slug}`,
    path: `${location}/${slug}`,
    commit,
  }
}

/** True only for the exact target hvirWorktreeTarget would derive for this root. */
export function isHvirWorktreeTarget(rootPath: string, target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const { branch, path, commit } = target as Record<string, unknown>
  if (
    typeof branch !== 'string' ||
    typeof path !== 'string' ||
    typeof commit !== 'string'
  )
    return false
  if (!branch.startsWith(HVIR_ARCHITECTURE_BRANCH_PREFIX)) return false
  const slug = branch.slice(HVIR_ARCHITECTURE_BRANCH_PREFIX.length)
  const location = locationOf(rootPath)
  return (
    SLUG.test(slug) &&
    COMMIT.test(commit) &&
    location !== undefined &&
    path === `${location}/${slug}`
  )
}

export function sameHvirWorktreeTarget(
  a: HvirWorktreeTarget | undefined,
  b: HvirWorktreeTarget,
): boolean {
  return (
    a !== undefined && a.branch === b.branch && a.path === b.path && a.commit === b.commit
  )
}

function locationOf(path: string): string | undefined {
  return path.startsWith('/') &&
    path !== '/' &&
    !path.endsWith('/') &&
    posix.normalize(path) === path
    ? `${path}.hvir-worktrees`
    : undefined
}
