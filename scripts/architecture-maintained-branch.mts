import process from 'node:process'
import { fullCommit, git, requireAncestor } from './architecture-inventory.mts'
import type { ArchitectureContext } from './architecture-authorization.mts'

// ADR-062: a maintainer-approved local policy baseline, never GitHub PR authority.
const MAINTAINED_BASE = '912cc42e1c41f431bc0d4c8a78cfaf0ca7c6c138'
const MAINTAINED_BRANCH = 'feat/beads-panel'

export function resolveMaintainedArchitectureContext(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): ArchitectureContext | null {
  if (environment.GITHUB_ACTIONS === 'true') return null
  if (git(root, ['branch', '--show-current']) !== MAINTAINED_BRANCH) return null
  const head = fullCommit(root, 'HEAD')
  requireAncestor(root, MAINTAINED_BASE, head)
  return {
    kind: 'ordinary',
    target: MAINTAINED_BRANCH,
    epic: null,
    base: MAINTAINED_BASE,
    head,
    tested: head,
  }
}
