import { describe, expect, it } from 'vitest'

import {
  companionGroupTitle,
  groupCompanionRows,
} from '../src/renderer/companion/src/companion-row-groups'
import { asSessionsProjectHandle, asSessionsWorkspaceHandle } from '../src/shared'
import { row } from './companion-page-fixture'

const workspace = (
  handle: string,
  name: string,
  host: { readonly label: string; readonly kind: 'local' | 'ssh' } = {
    label: 'Local',
    kind: 'local',
  },
) => ({
  handle: asSessionsWorkspaceHandle(handle),
  name,
  hostLabel: host.label,
  hostKind: host.kind,
})

describe('Companion row groups', () => {
  it('groups rows by workspace handle, sorted by project then workspace, rows in order', () => {
    const rows = [
      row({ handle: 'r1', workspace: workspace('w2', 'feature') }),
      row({ handle: 'r2', workspace: workspace('w1', 'main') }),
      row({
        handle: 'r3',
        project: { handle: asSessionsProjectHandle('p0'), name: 'api' },
        workspace: workspace('w9', 'main', { label: 'prod', kind: 'ssh' }),
      }),
      row({ handle: 'r4', workspace: workspace('w2', 'feature') }),
    ]
    const groups = groupCompanionRows(rows)
    expect(groups.map((group) => [group.key, group.rows.map((r) => r.handle)])).toEqual([
      ['w9', ['r3']],
      ['w2', ['r1', 'r4']],
      ['w1', ['r2']],
    ])
    expect(groups.map(companionGroupTitle)).toEqual([
      'api / main on prod',
      'hvir / feature',
      'hvir / main',
    ])
  })

  it('keeps two workspaces of the same name on different hosts apart, host label deciding', () => {
    const rows = [
      row({
        handle: 'r1',
        workspace: workspace('w2', 'main', { label: 'zed', kind: 'ssh' }),
      }),
      row({
        handle: 'r2',
        workspace: workspace('w1', 'main', { label: 'alpha', kind: 'ssh' }),
      }),
    ]
    expect(groupCompanionRows(rows).map(companionGroupTitle)).toEqual([
      'hvir / main on alpha',
      'hvir / main on zed',
    ])
  })

  it('has no groups for no rows and leaves the rows it was given untouched', () => {
    expect(groupCompanionRows([])).toEqual([])
    const rows = [row({ handle: 'r1' })]
    const groups = groupCompanionRows(rows)
    expect(groups[0]?.rows).not.toBe(rows)
    expect(rows).toHaveLength(1)
  })
})
