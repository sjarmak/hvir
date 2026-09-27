import type { HostPath } from '../../../shared'

export class ArchitectureExplanationStateSession {
  readonly #collapsed = new Map<string, boolean>()

  read(root: HostPath): boolean {
    return this.#collapsed.get(projectKey(root)) ?? false
  }

  write(root: HostPath, collapsed: boolean): void {
    this.#collapsed.set(projectKey(root), collapsed)
  }
}

function projectKey(root: HostPath): string {
  return JSON.stringify([root.hostId, root.path])
}
