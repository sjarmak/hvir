import {
  type BeadIssue,
  type BeadsListRequest,
  type BeadsListResponse,
  type BeadsUnavailable,
  type HostPath,
} from '../../shared'
import type { ExecLane, ProjectHost } from '../project-host'
import {
  classifyListFailure,
  logBeadsFailure,
  parseBeadsListOutput,
  parseBeadsWhereOutput,
} from './beads-parse'

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export class BeadsReader {
  async listForProject(
    req: BeadsListRequest,
    project: { readonly host: ProjectHost; readonly root: HostPath },
    lane: ExecLane = 'background',
  ): Promise<BeadsListResponse> {
    if (req.issuesOnly !== true) throw new Error('BeadsReader only supports issue reads')
    const result = await this.runList(project.host, project.root, lane)
    if (!result.ok) return result.unavailable
    return {
      available: true,
      issues: result.issues,
      readyIds: [],
      dispatchableIds: [],
      dispatchabilitySource: 'structural',
      dependencies: [],
      gates: [],
    }
  }

  async storeForProject(
    project: { readonly host: ProjectHost; readonly root: HostPath },
    lane: ExecLane = 'background',
  ): Promise<string | undefined> {
    const { host, root } = project
    const result = await host.exec('bd', ['-C', root.path, 'where', '--json'], {
      maxBuffer: MAX_OUTPUT_BYTES,
      loginShell: true,
      lane,
      timeout: 20_000,
    })
    return result.code === 0 ? parseBeadsWhereOutput(result.stdout) : undefined
  }

  private async runList(
    host: ProjectHost,
    root: HostPath,
    lane: ExecLane,
  ): Promise<
    | { readonly ok: true; readonly issues: readonly BeadIssue[] }
    | { readonly ok: false; readonly unavailable: BeadsUnavailable }
  > {
    const args = ['-C', root.path, 'list', '--json', '--flat', '--no-pager', '-n', '0']
    let result
    try {
      result = await host.exec('bd', args, {
        maxBuffer: MAX_OUTPUT_BYTES,
        loginShell: true,
        lane,
        timeout: 20_000,
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const missing = /ENOENT|not found/i.test(message)
      logBeadsFailure(root, args, { thrown: message })
      return {
        ok: false,
        unavailable: {
          available: false,
          reason: missing ? 'bd-missing' : 'error',
          message: missing ? 'The bd CLI is not installed on this host.' : message,
        },
      }
    }
    if (result.code !== 0) {
      const stderr = result.stderr.trim()
      logBeadsFailure(root, args, { code: result.code, stderr })
      return { ok: false, unavailable: classifyListFailure(root, stderr, result.code) }
    }
    try {
      return { ok: true, issues: parseBeadsListOutput(result.stdout) }
    } catch (reason) {
      return {
        ok: false,
        unavailable: {
          available: false,
          reason: 'error',
          message: reason instanceof Error ? reason.message : String(reason),
        },
      }
    }
  }
}
