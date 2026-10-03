import type { HostPath, NeedsYouSnapshot } from '../../../shared'

export interface NeedsYouProblem {
  readonly key: string
  readonly name: string
  readonly root: HostPath
  readonly details: readonly string[]
}

function readAt(observedAt: number): string {
  return `Read at ${new Date(observedAt).toLocaleTimeString()}`
}

function beadsProblem(read: NeedsYouSnapshot['sources'][number]['beads']): string[] {
  if (!read.response.available) {
    return read.response.reason === 'no-database'
      ? []
      : [`Beads: ${read.response.message} · ${readAt(read.observedAt)}`]
  }
  return read.truncated
    ? [
        `Beads: Partial: first ${read.itemLimit} items needing you only. Open the Beads rail for the full list. · ${readAt(read.observedAt)}`,
      ]
    : []
}

function pullsProblem(read: NeedsYouSnapshot['sources'][number]['pulls']): string[] {
  if (!read.response.available) {
    return read.response.reason === 'no-github-repo'
      ? []
      : [`PRs: ${read.response.message} · ${readAt(read.observedAt)}`]
  }
  return read.truncated
    ? [
        `PRs: Partial: first ${read.itemLimit} items per search only. · ${readAt(read.observedAt)}`,
      ]
    : []
}

export function needsYouProblems(snapshot: NeedsYouSnapshot): readonly NeedsYouProblem[] {
  const sources = snapshot.sources.map((source) => ({
    key: JSON.stringify(['source', source.root]),
    name: `${source.projectName} / ${source.workspaceName}`,
    root: source.root,
    details: [...beadsProblem(source.beads), ...pullsProblem(source.pulls)],
  }))
  const askStores = (snapshot.askStores ?? []).map((store) => ({
    key: JSON.stringify(['ask', store.root]),
    name: store.name,
    root: store.root,
    details: beadsProblem(store.beads),
  }))
  return [...askStores, ...sources].filter((problem) => problem.details.length > 0)
}
