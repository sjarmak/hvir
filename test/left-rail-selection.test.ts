import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import type { ExtensionView } from '../src/shared/extensions/workbench'
import {
  evictedLeftViews,
  leftViewFor,
  RETAINED_LEFT_WORKSPACES,
  touchWorkspace,
  withChoice,
} from '../src/renderer/src/extensions/left-rail-selection'

const leftView = (
  id: string,
  workspaceId: string,
  contributionId = 'projects',
): ExtensionView => ({
  id,
  installationId: 'one',
  contributionId,
  extensionName: 'Example',
  title: 'Projects',
  partition: `hvir-extension-${id}`,
  url: `hvir-extension://${id}/projects.html`,
  role: 'view',
  context: {
    surface: 'left',
    visible: true,
    workspace: { id: workspaceId, name: workspaceId, host: 'local' },
  },
})

describe('left rail selection', () => {
  it('finds the remembered contribution only among the workspace’s own left views', () => {
    const views = [
      leftView('a', 'one'),
      leftView('b', 'two'),
      leftView('c', 'two', 'pulls'),
    ]
    const choice = { installationId: 'one', contributionId: 'projects' }
    expect(leftViewFor(views, 'two', choice)?.id).toBe('b')
    expect(leftViewFor(views, 'three', choice)).toBeUndefined()
    expect(leftViewFor(views, 'two', undefined)).toBeUndefined()
    expect(
      leftViewFor([{ ...leftView('d', 'two'), role: 'updater' }], 'two', choice),
    ).toBeUndefined()
  })

  it('records and clears a choice without mutating the previous map', () => {
    const empty = new Map()
    const choice = { installationId: 'one', contributionId: 'projects' }
    const chosen = withChoice(empty, 'w', choice)
    expect(empty.size).toBe(0)
    expect(chosen.get('w')).toEqual(choice)
    expect(withChoice(chosen, 'w', undefined).has('w')).toBe(false)
    expect(chosen.has('w')).toBe(true)
  })

  it('evicts left views only for workspaces outside the retained set', () => {
    const views = [leftView('a', 'one'), leftView('b', 'two')]
    expect(evictedLeftViews(views, ['two']).map((view) => view.id)).toEqual(['a'])
  })

  it('keeps the newest workspace first, unique, and within the limit', () =>
    hegel.test((testCase) => {
      const visits = testCase.draw(
        gs.arrays(gs.sampledFrom(['a', 'b', 'c', 'd', 'e', 'f']), { maxSize: 20 }),
      )
      const recent = visits.reduce<readonly string[]>(
        (list, id) => touchWorkspace(list, id),
        [],
      )
      expect(recent.length).toBeLessThanOrEqual(RETAINED_LEFT_WORKSPACES)
      expect(new Set(recent).size).toBe(recent.length)
      if (visits.length) expect(recent[0]).toBe(visits.at(-1))
      const distinctNewestFirst = [...new Set([...visits].reverse())]
      expect(recent).toEqual(distinctNewestFirst.slice(0, RETAINED_LEFT_WORKSPACES))
    }))
})
