/**
 * Where a Gas City session belongs inside hvir's own grouping.
 *
 * gc has no opinion about hvir's projects and workspaces, so placement is
 * hvir's decision and it is made from paths alone: the workspace a session's
 * working directory is inside, then the main workspace of the project owning
 * its rig, then the main workspace of the project containing its working
 * directory. A session that lands in none of those belongs to work hvir does
 * not track, and showing it under an unrelated project would be worse than not
 * showing it at all.
 *
 * Two surfaces need the same answer — the projected row's workspace and the
 * project an external pending interaction raises attention on — so the rule
 * lives here once rather than being decided twice.
 */
import { containsHostPath, type HostPath } from '../../shared'

/** The paths a session reports about itself, and nothing else. */
export interface CityPlacementSubject {
  readonly workDir?: HostPath
  readonly rigRoot?: HostPath
}

/** One candidate workspace, with whatever the caller wants back for it. */
export interface CityPlacementTarget<T> {
  readonly root: HostPath
  readonly projectRoot: HostPath
  /** The project this workspace belongs to, however the caller names projects. */
  readonly projectKey: string
  readonly main: boolean
  readonly value: T
}

export function placeCitySession<T>(
  subject: CityPlacementSubject,
  targets: readonly CityPlacementTarget<T>[],
): T | undefined {
  const exact = deepest(targets, (target) => target.root, subject.workDir)
  if (exact !== undefined) return exact.value
  return (
    mainWorkspace(targets, subject.rigRoot) ?? mainWorkspace(targets, subject.workDir)
  )
}

function mainWorkspace<T>(
  targets: readonly CityPlacementTarget<T>[],
  path: HostPath | undefined,
): T | undefined {
  const owner = deepest(targets, (target) => target.projectRoot, path)
  if (owner === undefined) return undefined
  const main = targets.find(
    (target) => target.projectKey === owner.projectKey && target.main,
  )
  return (main ?? owner).value
}

/** The innermost containing target, so a worktree beats the project holding it. */
function deepest<T>(
  targets: readonly CityPlacementTarget<T>[],
  rootOf: (target: CityPlacementTarget<T>) => HostPath,
  path: HostPath | undefined,
): CityPlacementTarget<T> | undefined {
  if (path === undefined) return undefined
  let best: CityPlacementTarget<T> | undefined
  for (const target of targets) {
    const root = rootOf(target)
    if (!containsHostPath(root, path)) continue
    if (best === undefined || root.path.length > rootOf(best).path.length) best = target
  }
  return best
}
