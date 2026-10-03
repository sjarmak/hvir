import type {
  HostPath,
  NeedsYouSourceSnapshot,
  SessionsProjectionRow,
} from '../../../shared'
import { needsYouBeads, needsYouPulls } from './needs-you-model'

export interface NeedsYouBeadTarget {
  readonly projectId: string
  readonly workspaceId: string
  readonly root: HostPath
  readonly beadId: string
}

export interface NeedsYouRow {
  readonly key: string
  readonly title: string
  readonly source: string
  readonly context: string
  readonly reason: string
  readonly target:
    | { readonly kind: 'session'; readonly row: SessionsProjectionRow }
    | { readonly kind: 'bead'; readonly bead: NeedsYouBeadTarget }
    | { readonly kind: 'pull'; readonly url: string }
}

export function needsYouRows(
  sessions: readonly SessionsProjectionRow[],
  sources: readonly NeedsYouSourceSnapshot[],
): readonly NeedsYouRow[] {
  const sessionRows: NeedsYouRow[] = sessions
    .filter(
      (row) =>
        row.attention.status === 'available' &&
        row.attention.value !== 'none' &&
        row.connectionState === 'connected',
    )
    .map((row) => ({
      key: `session:${row.handle}`,
      title: row.title,
      source: 'Session',
      context: `${row.project.name} / ${row.workspace.name} · ${row.host.label}`,
      reason:
        row.attention.status === 'available'
          ? { ready: 'Ready', bell: 'Bell', prompt: 'Prompt', none: '' }[
              row.attention.value
            ]
          : '',
      target: { kind: 'session', row },
    }))
  const latestPullSources = new Map<string, NeedsYouSourceSnapshot>()
  for (const source of sources) {
    if (!source.pulls.response.available) continue
    const repo = source.pulls.response.repo.toLowerCase()
    const previous = latestPullSources.get(repo)
    if (!previous || source.pulls.observedAt > previous.pulls.observedAt) {
      latestPullSources.set(repo, source)
    }
  }
  const sourceRows = sources.flatMap((source): NeedsYouRow[] => {
    const context = `${source.projectName} / ${source.workspaceName} · ${source.root.hostId}:${source.root.path}`
    const beads: NeedsYouRow[] = needsYouBeads(source.beads.response).map((bead) => ({
      key: JSON.stringify(['bead', source.root.hostId, source.root.path, bead.id]),
      title: `${bead.id} · ${bead.title}`,
      source: 'Bead',
      context,
      reason: bead.labels.some((label) => label.toLowerCase() === 'needs-human')
        ? 'Needs human'
        : 'Decision requested',
      target: {
        kind: 'bead',
        bead: {
          projectId: source.projectId,
          workspaceId: source.workspaceId,
          root: source.root,
          beadId: bead.id,
        },
      },
    }))
    const response = source.pulls.response
    if (!response.available) return beads
    if (latestPullSources.get(response.repo.toLowerCase()) !== source) return beads
    const pulls = needsYouPulls(response).flatMap(({ pull, reasons }): NeedsYouRow[] => {
      const key = JSON.stringify(['pull', response.repo.toLowerCase(), pull.number])
      return [
        {
          key,
          title: `${response.repo} #${pull.number} · ${pull.title}`,
          source: 'PR',
          context,
          reason: reasons.join(' · '),
          target: { kind: 'pull', url: pull.url },
        },
      ]
    })
    return [...beads, ...pulls]
  })
  return [...sessionRows, ...sourceRows]
}
