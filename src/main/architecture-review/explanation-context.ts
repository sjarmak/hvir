import type { HostPath } from '../../shared/host-path'
import { ARCHITECTURE_LIVE_REVISION } from '../../shared/architecture-review'
import { boundTextWorkload } from '../../shared/viewer-workload-policy'
import { gitError } from '../git/git-command-context'
import type { ProjectHost } from '../project-host/project-host'
import { architectureGitContext, validateArchitectureRoot } from './git-context'

export interface ArchitectureExplanationContextRequest {
  readonly root: HostPath
  readonly baselineRevision: string
  readonly currentRevision: string
  readonly scope: readonly string[]
}

export interface ArchitectureExplanationCommit {
  readonly revision: string
  readonly subject: string
}

export interface ArchitectureExplanationContext {
  readonly commits: readonly ArchitectureExplanationCommit[]
  readonly commitsTruncated: boolean
  readonly diff: string
  readonly diffTruncated: boolean
}

const LOG_FORMAT = '--format=%H%x1f%s'
const MAX_LOG_BYTES = 1024 * 1024
const MAX_DIFF_INPUT_BYTES = 4 * 1024 * 1024
const MAX_COMMITS = 100
const MAX_DIFF_BYTES = 64 * 1024

const EMPTY: ArchitectureExplanationContext = {
  commits: [],
  commitsTruncated: false,
  diff: '',
  diffTruncated: false,
}

/** Commit messages and a diff for the reviewed range, bounded before they reach a prompt. */
export async function readArchitectureExplanationContext(
  host: ProjectHost,
  request: ArchitectureExplanationContextRequest,
  signal: AbortSignal,
): Promise<ArchitectureExplanationContext> {
  validateArchitectureRoot(host, request.root)
  const live = request.currentRevision === ARCHITECTURE_LIVE_REVISION
  if (!live && request.baselineRevision === request.currentRevision) return EMPTY
  const context = architectureGitContext(host, request.root, signal)
  const endpoint = live ? 'HEAD' : request.currentRevision
  const pathspec = request.scope.length > 0 ? ['--', ...request.scope] : []

  const logArgs = ['log', '-z', '--topo-order', LOG_FORMAT, `${request.baselineRevision}..${endpoint}`, ...pathspec]
  const logResult = await context.readOnly(request.root, logArgs, {
    maxBuffer: MAX_LOG_BYTES,
    allowTruncatedOutput: true,
  })
  if (logResult.code !== 0 && !logResult.outputTruncated)
    throw gitError(logArgs, logResult.stderr, logResult.code)
  const commits = parseCommitLog(logResult.stdout)

  const diffArgs = live
    ? ['diff', request.baselineRevision, ...pathspec]
    : ['diff', request.baselineRevision, request.currentRevision, ...pathspec]
  const diffResult = await context.readOnly(request.root, diffArgs, {
    maxBuffer: MAX_DIFF_INPUT_BYTES,
    allowTruncatedOutput: true,
  })
  if (diffResult.code !== 0 && !diffResult.outputTruncated)
    throw gitError(diffArgs, diffResult.stderr, diffResult.code)
  const workload = boundTextWorkload(
    diffResult.stdout,
    MAX_DIFF_BYTES,
    diffResult.outputTruncated !== true,
  )

  return {
    commits: commits.slice(0, MAX_COMMITS),
    commitsTruncated: logResult.outputTruncated === true || commits.length > MAX_COMMITS,
    diff: workload.content,
    diffTruncated: !workload.complete,
  }
}

function parseCommitLog(output: string): readonly ArchitectureExplanationCommit[] {
  return output
    .split('\0')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [revision = '', ...subject] = record.split('\x1f')
      return { revision, subject: subject.join('\x1f') }
    })
    .filter((commit) => /^[a-f0-9]{40,64}$/.test(commit.revision))
}
