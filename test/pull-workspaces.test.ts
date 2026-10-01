import * as hegel from '@hegeldev/hegel'
import * as generators from '@hegeldev/hegel/generators'
import { describe, expect, it } from 'vitest'

import { resolvePullWorkspaces } from '../src/renderer/src/github/pull-workspaces'
import { asHostId, hostPath, type WorkspaceState } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/projects/widgets/feature')
const PULL = { headRef: 'feature', headRepo: 'acme/widgets' }
const WORKSPACE: WorkspaceState = {
  id: 'feature',
  root: ROOT,
  name: 'feature',
  branch: 'renamed',
  main: false,
  closed: false,
  missing: false,
  repository: true,
  changedFiles: 0,
}
const CHECKOUT = { root: ROOT, branch: 'renamed', ...PULL }

function resolve(checkouts = [CHECKOUT], workspaces = [WORKSPACE]) {
  return resolvePullWorkspaces(PULL, { available: true, checkouts }, workspaces)
}

describe('PR workspace association', () => {
  it('matches renamed local branches by upstream repository and branch', () => {
    expect(resolve()).toEqual({ status: 'matches', workspaces: [WORKSPACE] })
  })

  it('includes closed workspaces but excludes missing and unregistered roots', () => {
    expect(resolve([CHECKOUT], [{ ...WORKSPACE, closed: true }]).status).toBe('matches')
    expect(resolve([CHECKOUT], [{ ...WORKSPACE, missing: true }]).status).toBe('none')
    expect(resolve([CHECKOUT], []).status).toBe('none')
  })

  it('rejects fork collisions and respects case-sensitive branch names', () => {
    expect(resolve([{ ...CHECKOUT, headRepo: 'someone/widgets' }]).status).toBe('none')
    expect(resolve([{ ...CHECKOUT, headRef: 'FEATURE' }]).status).toBe('none')
    expect(resolve([{ ...CHECKOUT, headRepo: 'ACME/Widgets' }]).status).toBe('matches')
  })

  it('distinguishes an unverified same-name checkout from no checkout', () => {
    expect(
      resolvePullWorkspaces(
        PULL,
        {
          available: true,
          checkouts: [{ root: ROOT, branch: 'feature' }],
        },
        [{ ...WORKSPACE, branch: 'feature' }],
      ).status,
    ).toBe('unverified')
    expect(
      resolvePullWorkspaces(PULL, { available: false, message: 'offline' }, [WORKSPACE])
        .status,
    ).toBe('unverified')
    expect(
      resolvePullWorkspaces(
        { headRef: 'feature' },
        { available: true, checkouts: [CHECKOUT] },
        [WORKSPACE],
      ).status,
    ).toBe('unverified')
    expect(resolve([]).status).toBe('none')
  })

  it('offers all confirmed matches without choosing a preferred checkout', () => {
    const second = { ...WORKSPACE, id: 'second', root: { ...ROOT, path: '/second' } }
    expect(
      resolve([CHECKOUT, { ...CHECKOUT, root: second.root }], [WORKSPACE, second]),
    ).toEqual({
      status: 'matches',
      workspaces: [WORKSPACE, second],
    })
  })

  it('never matches a host or path other than the discovered checkout', () =>
    hegel.test((tc) => {
      const suffix = tc.draw(generators.integers({ minValue: 1, maxValue: 10000 }))
      expect(
        resolve(
          [CHECKOUT],
          [{ ...WORKSPACE, root: hostPath(asHostId(`ssh-${suffix}`), ROOT.path) }],
        ).status,
      ).toBe('none')
      expect(
        resolve(
          [CHECKOUT],
          [{ ...WORKSPACE, root: { ...ROOT, path: `${ROOT.path}-${suffix}` } }],
        ).status,
      ).toBe('none')
    }))
})
