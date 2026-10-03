import { BeadsService } from '../beads/beads-service'
import { GitHubService } from '../github/github-service'
import type { ProjectHost } from '../project-host'
import { type ExecOptions } from '../project-host'
import {
  hostPathEquals,
  joinHostPath,
  type ExecResult,
  type HostPath,
  type Stat,
} from '../../shared'

const SYNTHETIC_BEAD_ID = 'smoke-eval-1'
const SYNTHETIC_PULL_NUMBER = 91
const SYNTHETIC_REPO = 'smoke/example'
const SYNTHETIC_HEAD = '0123456789abcdef0123456789abcdef01234567'
const SYNTHETIC_RUN_URL = 'https://eval.example/runs/smoke-91'
const HOSTILE_FEEDBACK = '<img src=x onerror=alert(1)>'

export function createQolRailServices(options: {
  readonly host: ProjectHost
  readonly root: HostPath
  readonly synthetic?: boolean
}): {
  readonly host: ProjectHost
  readonly beads: BeadsService
  readonly github: GitHubService
} {
  const smokeHost = options.synthetic ? createQolHost(options.host, options.root) : options.host
  return {
    host: smokeHost,
    beads: new BeadsService({
      getProject: () => ({ host: smokeHost, root: options.root }),
    }),
    github: new GitHubService({
      getProject: () => ({ host: smokeHost, root: options.root }),
    }),
  }
}

function createQolHost(host: ProjectHost, root: HostPath): ProjectHost {
  const proxy = Object.create(host) as ProjectHost
  Object.defineProperty(proxy, 'exec', {
    value: (command: string, args: readonly string[], options?: ExecOptions) =>
      syntheticExec(host, root, command, args, options),
  })
  Object.defineProperty(proxy, 'stat', {
    value: (path: HostPath) => syntheticStat(host, root, path),
  })
  return proxy
}

async function syntheticExec(
  host: ProjectHost,
  root: HostPath,
  command: string,
  args: readonly string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  if (options?.cwd !== undefined && !hostPathEquals(options.cwd, root)) {
    return host.exec(command, args, options)
  }
  if (command === 'bd' && args.includes(root.path)) return beadResult(args)
  if (command === 'gh') return githubResult(args)
  if (command === 'git' && args[0] === 'remote') {
    return result('origin\thttps://github.com/smoke/example (fetch)\n')
  }
  if (command === 'git' && args[0] === 'symbolic-ref') return result('feat/smoke\n')
  return host.exec(command, args, options)
}

function syntheticStat(host: ProjectHost, root: HostPath, path: HostPath): Promise<Stat> {
  if (hostPathEquals(path, joinHostPath(root, '.beads'))) {
    return Promise.resolve({ type: 'dir', mode: 0o755, size: 0, mtimeMs: 0 })
  }
  return host.stat(path)
}

function beadResult(args: readonly string[]): ExecResult {
  if (args.includes('gate')) return result('[]')
  if (args.includes('digraph')) return result('')
  if (args.includes('list')) return result(JSON.stringify([syntheticBead()]))
  return result('')
}

function syntheticBead(): Record<string, unknown> {
  return {
    id: SYNTHETIC_BEAD_ID,
    title: 'Synthetic evaluation result',
    status: 'open',
    priority: 1,
    issue_type: 'task',
    labels: ['needs-human'],
    metadata: {
      'eval.run_url': SYNTHETIC_RUN_URL,
      'eval.run_id': 'smoke-91',
      'eval.candidate_sha': SYNTHETIC_HEAD,
      'eval.model': 'synthetic-model',
      'eval.config': 'smoke',
      'eval.recorded_at': '2026-10-02T00:00:00Z',
    },
  }
}

function githubResult(args: readonly string[]): ExecResult {
  if (args[0] === 'repo') return result(JSON.stringify({ nameWithOwner: SYNTHETIC_REPO }))
  const query = args.find((arg) => arg.startsWith('query=')) ?? ''
  if (query.includes('pullRequest(number')) return result(JSON.stringify(detailPayload()))
  return result(JSON.stringify(pullsPayload()))
}

function pullsPayload(): Record<string, unknown> {
  const pull = {
    number: SYNTHETIC_PULL_NUMBER,
    title: 'Synthetic review feedback',
    url: `https://github.com/${SYNTHETIC_REPO}/pull/${SYNTHETIC_PULL_NUMBER}`,
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/smoke',
    updatedAt: '2026-10-02T00:00:00Z',
    reviewDecision: 'CHANGES_REQUESTED',
    headRepository: { nameWithOwner: SYNTHETIC_REPO },
    author: { login: 'smoke-reviewer' },
    commits: {
      nodes: [
        {
          commit: {
            oid: SYNTHETIC_HEAD,
            committedDate: '2026-10-02T00:00:00Z',
            statusCheckRollup: { state: 'SUCCESS' },
          },
        },
      ],
    },
    reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] },
    reviews: {
      nodes: [
        {
          state: 'CHANGES_REQUESTED',
          body: HOSTILE_FEEDBACK,
          submittedAt: '2026-10-02T00:00:00Z',
          author: { __typename: 'User', login: 'smoke-reviewer' },
        },
      ],
    },
    comments: { nodes: [] },
  }
  return {
    data: {
      viewer: { login: 'smoke-user' },
      repository: { branch: { nodes: [pull] } },
      mine: { nodes: [] },
      review: { nodes: [pull] },
    },
  }
}

function detailPayload(): Record<string, unknown> {
  return {
    data: {
      repository: {
        pullRequest: {
          number: SYNTHETIC_PULL_NUMBER,
          title: 'Synthetic review feedback',
          url: `https://github.com/${SYNTHETIC_REPO}/pull/${SYNTHETIC_PULL_NUMBER}`,
          headRefOid: SYNTHETIC_HEAD,
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: 'smoke-thread-1',
                isResolved: false,
                isOutdated: false,
                path: 'src/smoke.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      id: 'smoke-comment-1',
                      body: HOSTILE_FEEDBACK,
                      createdAt: '2026-10-02T00:00:00Z',
                      commit: { oid: SYNTHETIC_HEAD },
                      author: { login: 'smoke-reviewer' },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  }
}

function result(stdout: string): ExecResult {
  return { code: 0, signal: null, stdout, stderr: '' }
}
