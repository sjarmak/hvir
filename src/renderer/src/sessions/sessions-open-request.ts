import type {
  SessionsOpenResponse,
  SessionsProjectionRow,
  SessionsProjectionSnapshot,
} from '../../../shared'

export function requestSessionOpen(
  captured: Pick<SessionsProjectionSnapshot, 'demandGeneration' | 'sourceRevision'>,
  row: SessionsProjectionRow,
): Promise<SessionsOpenResponse> {
  return window.hvir.invoke('sessions:open', {
    demandGeneration: captured.demandGeneration,
    sourceRevision: captured.sourceRevision,
    handle: row.handle,
    projectId: row.project.id,
    workspaceId: row.workspace.id,
    workspaceQualifier: row.workspace.qualifier,
    livePty: row.livePty,
  })
}
