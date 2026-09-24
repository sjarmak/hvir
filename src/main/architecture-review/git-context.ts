import { hostPathEquals, joinHostPath, type HostPath } from '../../shared/host-path'
import { ARCHITECTURE_SCOPE as SCOPE } from '../../shared/architecture-review'
import type { ProjectHost } from '../project-host/project-host'
import { GitCommandContext } from '../git/git-command-context'

const COMMAND_TIMEOUT = 30_000

export type Counted = <T>(call: () => Promise<T>) => Promise<T>
const uncounted: Counted = (call) => call()

/** Refuses a root on another host, a relative or unnormalized root, or a closed host. */
export function validateArchitectureRoot(host: ProjectHost, root: HostPath): void {
  if (
    root.hostId !== host.hostId ||
    !root.path.startsWith('/') ||
    !hostPathEquals(root, joinHostPath(root)) ||
    root.path.includes('\0')
  ) {
    throw new Error('Invalid architecture workspace')
  }
  if (host.connectionState !== 'connected')
    throw new Error('Reconnect the host before reviewing architecture')
}

/** Git access for the review, bounded per command and counted per host round trip. */
export function architectureGitContext(
  host: ProjectHost,
  root: HostPath,
  signal: AbortSignal,
  counted: Counted = uncounted,
): GitCommandContext {
  return new GitCommandContext(
    {
      hostId: host.hostId,
      exec: (command, args, options) =>
        counted(() =>
          host.exec(command, args, {
            ...options,
            signal,
            timeout: COMMAND_TIMEOUT,
            maxBuffer: options?.maxBuffer ?? SCOPE.maxListingBytes,
          }),
        ),
      stat: (path) => counted(() => host.stat(path)),
      readTextFile: (path) => counted(() => host.readTextFile(path, 'utf8', { signal })),
      readTextFilePrefix: (path, bytes) =>
        counted(() => host.readTextFilePrefix(path, bytes, { signal })),
    },
    root,
  )
}
