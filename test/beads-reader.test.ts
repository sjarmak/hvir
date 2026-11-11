import { describe, expect, it, vi } from 'vitest'

import { BeadsReader } from '../src/main/beads/beads-reader'
import {
  classifyListFailure,
  parseBeadsListOutput,
  parseBeadsWhereOutput,
} from '../src/main/beads/beads-parse'
import type { ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, type ExecResult } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/projects/demo')

function result(code: number, stdout: string, stderr = ''): ExecResult {
  return { code, signal: null, stdout, stderr }
}

function hostWith(
  exec: (command: string, args: readonly string[]) => Promise<ExecResult> | ExecResult,
): { readonly host: ProjectHost; readonly exec: ReturnType<typeof vi.fn> } {
  const mocked = vi.fn(exec)
  return {
    host: { hostId: ROOT.hostId, exec: mocked } as unknown as ProjectHost,
    exec: mocked,
  }
}

describe('BeadsReader', () => {
  it('reads only issue records on the requested lane', async () => {
    const data = hostWith(() =>
      result(
        0,
        JSON.stringify([
          {
            id: 'demo-1',
            title: 'Ask for input',
            status: 'open',
            issue_type: 'task',
            labels: ['needs-human'],
          },
        ]),
      ),
    )
    const response = await new BeadsReader().listForProject(
      { root: ROOT, issuesOnly: true },
      { host: data.host, root: ROOT },
      'interactive',
    )
    expect(response).toMatchObject({
      available: true,
      issues: [{ id: 'demo-1', title: 'Ask for input' }],
      readyIds: [],
      dispatchableIds: [],
      dependencies: [],
      gates: [],
    })
    expect(data.exec).toHaveBeenCalledOnce()
    expect(data.exec.mock.calls[0]?.[2]).toMatchObject({ lane: 'interactive' })
  })

  it('returns an actionable unavailability when bd cannot run', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const data = hostWith(() => Promise.reject(new Error('spawn bd ENOENT')))
    await expect(
      new BeadsReader().listForProject(
        { root: ROOT, issuesOnly: true },
        { host: data.host, root: ROOT },
      ),
    ).resolves.toEqual({
      available: false,
      reason: 'bd-missing',
      message: 'The bd CLI is not installed on this host.',
    })
    errors.mockRestore()
  })

  it('resolves the backing store on the requested lane', async () => {
    const data = hostWith(() => result(0, '{"path":"/projects/main/.beads"}'))
    await expect(
      new BeadsReader().storeForProject(
        { host: data.host, root: ROOT },
        'interactive',
      ),
    ).resolves.toBe('/projects/main/.beads')
    expect(data.exec).toHaveBeenCalledWith(
      'bd',
      ['-C', ROOT.path, 'where', '--json'],
      expect.objectContaining({ lane: 'interactive' }),
    )
  })
})

describe('BeadsReader parsing', () => {
  it('validates issue identity and required fields', () => {
    expect(
      parseBeadsListOutput(
        '[{"id":"demo-1","title":"Title","status":"open","priority":1}]',
      ),
    ).toMatchObject([{ id: 'demo-1', title: 'Title', status: 'open', priority: 1 }])
    expect(() =>
      parseBeadsListOutput('[{"id":"bad id","title":"Title","status":"open"}]'),
    ).toThrow('valid bd id')
  })

  it('accepts only absolute store paths', () => {
    expect(parseBeadsWhereOutput('{"path":"/a/.beads"}')).toBe('/a/.beads')
    expect(parseBeadsWhereOutput('{"path":"relative"}')).toBeUndefined()
    expect(parseBeadsWhereOutput('not json')).toBeUndefined()
  })

  it('distinguishes a missing database from an unreachable server', () => {
    expect(classifyListFailure(ROOT, 'no beads project found', 1).reason).toBe(
      'no-database',
    )
    expect(classifyListFailure(ROOT, 'dial tcp 127.0.0.1:0: connect', 1).reason).toBe(
      'server-unreachable',
    )
  })
})
