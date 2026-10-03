import type { SessionsLivePtyQualifier, SessionsProjectionRow } from '../../../shared'

export function sameSessionTarget(
  left: SessionsProjectionRow,
  right: SessionsProjectionRow,
): boolean {
  return (
    left.handle === right.handle &&
    left.project.id === right.project.id &&
    left.workspace.id === right.workspace.id &&
    left.workspace.qualifier === right.workspace.qualifier &&
    sameLivePty(left.livePty, right.livePty)
  )
}

function sameLivePty(
  left: SessionsLivePtyQualifier | undefined,
  right: SessionsLivePtyQualifier | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.handle === right.handle &&
    left.rendererOwnerId === right.rendererOwnerId &&
    left.rendererGeneration === right.rendererGeneration
  )
}
