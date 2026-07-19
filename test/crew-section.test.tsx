import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CrewSection } from '../src/renderer/src/beads/CrewSection'
import { buildCrewView } from '../src/renderer/src/beads/crew-model'
import { gasCityCommand } from '../src/renderer/src/beads/gascity-commands'
import {
  asHostId,
  hostPath,
  type BeadIssue,
  type GasCityCrew,
  type GasCityCrewMember,
} from '../src/shared'

const HOST = asHostId('local')

function member(overrides: Partial<GasCityCrewMember> = {}): GasCityCrewMember {
  return {
    key: 'gc-1',
    tier: 'worker',
    label: 'mem-worker-ash',
    target: 'mem-worker-ash',
    identityKeys: ['gc-1', 'mem-worker-ash'],
    poolName: 'mem-worker',
    session: {
      id: 'gc-1',
      name: 'mem-worker-ash',
      state: 'active',
      workDir: hostPath(HOST, '/rigs/mem'),
    },
    ...overrides,
  }
}

function issue(overrides: Partial<BeadIssue> = {}): BeadIssue {
  return {
    id: 'mem-42',
    title: 'Compact the ledger',
    status: 'in_progress',
    priority: 1,
    issueType: 'task',
    labels: [],
    dependencyCount: 0,
    dependentCount: 0,
    ...overrides,
  }
}

function crew(members: readonly GasCityCrewMember[]): GasCityCrew {
  return {
    available: true,
    members,
    tierSource: 'config',
    scope: 'rig',
    rigName: 'mem',
    diagnostics: { namedSessions: 4, pinned: 2, unmatched: [] },
  }
}

describe('crew view', () => {
  it('joins an in-flight bead to the member its assignee names', () => {
    const view = buildCrewView(crew([member()]), [issue({ assignee: 'mem-worker-ash' })])
    expect(view.pools[0]?.cards[0]?.bead?.title).toBe('Compact the ledger')
  })

  it('ignores an assignee that matches no crew identity', () => {
    const view = buildCrewView(crew([member()]), [issue({ assignee: 'someone-else' })])
    expect(view.pools[0]?.cards[0]?.bead).toBeUndefined()
  })

  it('ignores beads that are not in flight', () => {
    const view = buildCrewView(crew([member()]), [
      issue({ assignee: 'mem-worker-ash', status: 'open' }),
    ])
    expect(view.pools[0]?.cards[0]?.bead).toBeUndefined()
  })

  it("prefers gc's own active_bead projection over assignee matching", () => {
    const projected = member({
      session: {
        id: 'gc-1',
        name: 'mem-worker-ash',
        state: 'active',
        activeBead: 'mem-77',
      },
    })
    const view = buildCrewView(crew([projected]), [
      issue({ id: 'mem-77', title: 'Rotate the keys' }),
      issue({ id: 'mem-42', assignee: 'mem-worker-ash' }),
    ])
    expect(view.pools[0]?.cards[0]?.bead?.id).toBe('mem-77')
  })

  it('surfaces formula and molecule context from gc metadata', () => {
    const view = buildCrewView(crew([member()]), [
      issue({
        assignee: 'mem-worker-ash',
        metadata: { 'gc.formula': 'ship-it', 'gc.molecule': 'ledger-rework' },
      }),
    ])
    expect(view.pools[0]?.cards[0]?.bead?.formula).toBe('ship-it')
    expect(view.pools[0]?.cards[0]?.bead?.molecule).toBe('ledger-rework')
  })

  it('splits leads out of the pool grouping', () => {
    const view = buildCrewView(
      crew([
        member(),
        member({ key: 'gc-2', tier: 'lead', label: 'mem-pl', target: 'mem-pl' }),
      ]),
      [],
    )
    expect(view.leads.map((card) => card.member.label)).toEqual(['mem-pl'])
    expect(view.pools).toHaveLength(1)
    expect(view.total).toBe(2)
  })
})

describe('gc command construction', () => {
  it('keys attach so a repeat click can focus the live terminal', () => {
    expect(gasCityCommand('attach', 'mayor')).toEqual({
      command: "gc session attach 'mayor'",
      key: 'gc:mayor',
    })
  })

  it('leaves one-shot commands unkeyed so each gets a fresh shell', () => {
    expect(gasCityCommand('peek', 'mayor').key).toBeUndefined()
    expect(gasCityCommand('reset', 'mayor').command).toBe("gc session reset 'mayor'")
  })

  it('targets handoff at the named session with the subject gc requires', () => {
    expect(gasCityCommand('handoff', 'mayor').command).toBe(
      "gc handoff --target 'mayor' 'hvir handoff'",
    )
  })

  it('quotes a target that would otherwise break out of the command line', () => {
    expect(gasCityCommand('attach', "a'; rm -rf /").command).toBe(
      "gc session attach 'a'\\''; rm -rf /'",
    )
  })
})

describe('CrewSection rendering', () => {
  function render(props: Parameters<typeof CrewSection>[0]): string {
    return renderToStaticMarkup(createElement(CrewSection, props))
  }

  const noop = (): void => undefined

  it('renders leads with their four restart affordances', () => {
    const markup = render({
      response: crew([
        member({ key: 'gc-2', tier: 'lead', label: 'mem-pl', target: 'mem-pl' }),
      ]),
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    for (const label of ['Attach', 'Peek', 'Reset', 'Handoff']) {
      expect(markup).toContain(label)
    }
    expect(markup).toContain('mem-pl')
  })

  it('offers the same four actions on a worker card', () => {
    const markup = render({
      response: crew([member()]),
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    for (const label of ['Attach', 'Peek', 'Reset', 'Handoff']) {
      expect(markup).toContain(label)
    }
  })

  it('shows a dormant lead as not running rather than hiding it', () => {
    const markup = render({
      response: crew([
        {
          key: 'config:mem-pl',
          tier: 'lead',
          label: 'mem-pl',
          target: 'mem-pl',
          identityKeys: ['mem-pl'],
        },
      ]),
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(markup).toContain('not running')
  })

  it('names the scope so a city-wide crew in a rig workspace is visible', () => {
    const rigScoped = render({
      response: crew([member()]),
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(rigScoped).toContain('mem')
    expect(rigScoped).not.toContain('city-wide')

    const cityScoped = render({
      response: { ...crew([member()]), scope: 'city' },
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(cityScoped).toContain('city-wide')
  })

  it('says so when the config yielded no pinned identities at all', () => {
    // The failure that cost five rounds: a config key read under the wrong name
    // produces zero leads and looks exactly like a city that has none.
    const markup = render({
      response: {
        ...crew([member()]),
        diagnostics: { namedSessions: 0, pinned: 0, unmatched: [] },
      },
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(markup).toContain('No pinned identities')
    expect(markup).toContain('0 named sessions')
  })

  it('names the sessions no config entry describes, and counts the rest', () => {
    const markup = render({
      response: {
        ...crew([member()]),
        diagnostics: { namedSessions: 4, pinned: 2, unmatched: ['a', 'b', 'c', 'd', 'e'] },
      },
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(markup).toContain('Unclassified')
    expect(markup).toContain('a, b, c')
    expect(markup).toContain('+2')
  })

  it('stays quiet when everything was accounted for', () => {
    const markup = render({
      response: crew([member()]),
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(markup).not.toContain('Unclassified')
    expect(markup).not.toContain('No pinned identities')
  })

  it('renders nothing outside a Gas City', () => {
    const markup = render({
      response: { available: false, reason: 'no-city', message: 'nope' },
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(markup).toBe('')
  })

  it('reports a real gc failure instead of silently showing no crew', () => {
    const markup = render({
      response: { available: false, reason: 'error', message: 'gc exploded' },
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(markup).toContain('gc exploded')
  })
})
