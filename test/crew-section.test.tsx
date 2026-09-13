import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CrewSection } from '../src/renderer/src/beads/CrewSection'
import { buildCrewView, holdsBead } from '../src/renderer/src/beads/crew-model'
import { gasCityCommand } from '../src/renderer/src/beads/gascity-commands'
import {
  asHostId,
  hostPath,
  type BeadIssue,
  type GasCityAnalyticsConfig,
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

  it('lists every open bead the assignee holds, active bead excluded and in-flight first', () => {
    const view = buildCrewView(crew([member()]), [
      issue({ id: 'mem-1', status: 'open', priority: 2, assignee: 'mem-worker-ash' }),
      issue({ id: 'mem-42', status: 'in_progress', assignee: 'mem-worker-ash' }),
      issue({ id: 'mem-7', status: 'in_progress', priority: 3, assignee: 'mem-worker-ash' }),
      issue({ id: 'mem-3', status: 'blocked', priority: 0, assignee: 'mem-worker-ash' }),
      issue({ id: 'mem-9', status: 'closed', assignee: 'mem-worker-ash' }),
    ])
    const card = view.pools[0]?.cards[0]
    expect(card?.bead?.id).toBe('mem-42')
    expect(card?.held.map((held) => held.id)).toEqual(['mem-7', 'mem-3', 'mem-1'])
    expect(card?.held.map((held) => held.inFlight)).toEqual([true, false, false])
  })

  it('joins a path-shaped assignee that equals the session template', () => {
    const templated = member({
      identityKeys: ['gc-1', 'goal-3-decisions', '/home/ds/gas-city/goal-3-decisions'],
    })
    const view = buildCrewView(crew([templated]), [
      issue({ id: 'g-1', status: 'open', assignee: '/home/ds/gas-city/goal-3-decisions' }),
      issue({ id: 'g-2', status: 'open', assignee: 'goal-3-decisions' }),
      issue({ id: 'g-3', status: 'open', assignee: '/elsewhere/goal-3-decisions' }),
    ])
    expect(view.pools[0]?.cards[0]?.held.map((held) => held.id)).toEqual(['g-1', 'g-2'])
  })

  it('does not prefix-match a pool instance onto its template', () => {
    const template = member({
      identityKeys: ['/home/ds/gas-city/city-infra-worker', 'city-infra-worker'],
    })
    const view = buildCrewView(crew([template]), [
      issue({ id: 'c-1', status: 'open', assignee: '/home/ds/gas-city/city-infra-worker-1' }),
    ])
    expect(view.pools[0]?.cards[0]?.held).toEqual([])
  })

  it('leaves human and pseudo assignees unjoined', () => {
    const view = buildCrewView(crew([member()]), [
      issue({ id: 'h-1', status: 'open', assignee: 'sjarmak' }),
      issue({ id: 'h-2', status: 'open', assignee: 'controller' }),
      issue({ id: 'h-3', status: 'open' }),
    ])
    expect(view.pools[0]?.cards[0]?.held).toEqual([])
  })

  it('held is empty when the member holds nothing', () => {
    const view = buildCrewView(crew([member()]), [])
    expect(view.pools[0]?.cards[0]?.held).toEqual([])
  })
})

describe('holdsBead', () => {
  const keyed = member({
    identityKeys: ['gc-1', 'mem-worker-ash', '/home/ds/gas-city/mem-worker-ash'],
  })

  it.each([
    ['exact alias', 'mem-worker-ash', true],
    ['undefined assignee', undefined, false],
    ['empty assignee', '', false],
    ['bare name not in keys', 'mem-worker', false],
    ['qualified path in keys', '/home/ds/gas-city/mem-worker-ash', true],
  ])('%s -> %s', (_label, assignee, expected) => {
    expect(holdsBead(keyed, issue({ assignee }))).toBe(expected)
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

  it('marks the city lead so it reads as the head of the crew', () => {
    const markup = render({
      response: crew([
        member({
          key: 'gc-9',
          tier: 'lead',
          label: 'mayor',
          target: 'mayor',
          cityLead: true,
        }),
      ]),
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(markup).toContain('crew-card-city')
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

  it('renders held beads as buttons that report the bead id', () => {
    const held = [1, 2, 3, 4, 5, 6].map((n) =>
      issue({ id: `mem-${n}`, title: `Task ${n}`, status: 'open', assignee: 'mem-worker-ash' }),
    )
    const markup = render({
      response: crew([member()]),
      issues: held,
      collapsed: false,
      onToggle: noop,
      onAction: noop,
      onSelectBead: noop,
    })
    expect(markup).toContain('crew-held-bead')
    expect(markup).toContain('mem-1')
    expect(markup).not.toContain('disabled')
    expect(markup).toContain('+2')
    // The list role sits on a wrapper so the button keeps its button role.
    expect(markup).toContain('<span class="crew-held-item" role="listitem"><button')
    expect(markup).not.toMatch(/<button[^>]*role="listitem"/)
  })

  it('disables a held chip whose bead has no row on screen and says why', () => {
    const markup = render({
      response: crew([member()]),
      issues: [
        issue({ id: 'mem-1', status: 'open', assignee: 'mem-worker-ash' }),
        issue({ id: 'mem-2', status: 'open', issueType: 'gate', assignee: 'mem-worker-ash' }),
      ],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
      onSelectBead: noop,
      renderedBeadIds: new Set(['mem-1']),
    })
    const chips = [...markup.matchAll(/<button[^>]*class="crew-held-bead[^"]*"[^>]*>/g)].map(
      (match) => match[0],
    )
    expect(chips).toHaveLength(2)
    expect(chips[0]).not.toContain('disabled')
    expect(chips[1]).toContain('disabled')
    expect(chips[1]).toContain('hidden by the current filters')
  })

  it('disables held buttons without onSelectBead', () => {
    const markup = render({
      response: crew([member()]),
      issues: [issue({ id: 'mem-1', status: 'open', assignee: 'mem-worker-ash' })],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
    })
    expect(markup).toContain('crew-held-bead')
    expect(markup).toContain('disabled')
  })

  it('omits the held row when nothing is held', () => {
    const markup = render({
      response: crew([member()]),
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
      onSelectBead: noop,
    })
    expect(markup).not.toContain('crew-held')
  })
})

describe('CrewSection observability links', () => {
  function render(props: Parameters<typeof CrewSection>[0]): string {
    return renderToStaticMarkup(createElement(CrewSection, props))
  }

  const noop = (): void => undefined
  const analytics: GasCityAnalyticsConfig = {
    honeycomb: { team: 'steph.jarmak', environment: 'test', dataset: 'gas-city-agent' },
    omni: { baseUrl: 'https://sjarmak.omniapp.co' },
  }

  /** The opening tags of every anchor whose text is exactly `label`. */
  function anchors(markup: string, label: string): string[] {
    return [...markup.matchAll(new RegExp(`(<a [^>]*>)${label}</a>`, 'g'))].map(
      (match) => match[1] as string,
    )
  }

  function hrefOf(tag: string): string {
    const href = /href="([^"]*)"/.exec(tag)?.[1] ?? ''
    return href.replaceAll('&amp;', '&')
  }

  function filtersOf(href: string): Record<string, string> {
    const raw = new URL(href).searchParams.get('query') ?? ''
    const spec = JSON.parse(raw) as { filters: { column: string; value: string }[] }
    return Object.fromEntries(spec.filters.map((filter) => [filter.column, filter.value]))
  }

  function base(overrides: Partial<Parameters<typeof CrewSection>[0]> = {}) {
    return {
      response: crew([member({ session: { id: 'gc-1', name: 'x', state: 'active', template: 'mem/polecat' } })]),
      issues: [],
      collapsed: false,
      onToggle: noop,
      onAction: noop,
      analytics,
      ...overrides,
    }
  }

  it('renders an Analytics anchor beside, not inside, the header button', () => {
    const markup = render(base())
    const [analyticsTag] = anchors(markup, 'Analytics')
    expect(analyticsTag).toBeDefined()
    expect(hrefOf(analyticsTag as string).startsWith('https://sjarmak.omniapp.co')).toBe(true)
    expect(analyticsTag).toContain('target="_blank"')
    expect(analyticsTag).toContain('rel="noopener noreferrer"')
    const button = /<button[^>]*class="beads-section-header"[^>]*>[\s\S]*?<\/button>/.exec(markup)
    expect(button?.[0]).not.toContain('<a ')
  })

  it('renders a Trace anchor per member filtered on its agent name and rig', () => {
    const markup = render(base())
    const [traceTag] = anchors(markup, 'Trace')
    expect(traceTag).toBeDefined()
    expect(traceTag).toContain('target="_blank"')
    expect(traceTag).toContain('rel="noopener noreferrer"')
    expect(filtersOf(hrefOf(traceTag as string))).toEqual({
      'gen_ai.agent.name': 'mem.polecat',
      'gc.rig': 'mem',
    })
  })

  it('suppresses the Trace anchor for a name gas-city would not have exported', () => {
    const markup = render(
      base({ response: crew([member({ session: { id: 'gc-1', name: 'a b', state: 'active' } })]) }),
    )
    expect(anchors(markup, 'Trace')).toHaveLength(0)
    expect(anchors(markup, 'Analytics')).toHaveLength(1)
  })

  it('renders each surface only when its config is present', () => {
    const noOmni = render(base({ analytics: { honeycomb: analytics.honeycomb } }))
    expect(anchors(noOmni, 'Analytics')).toHaveLength(0)
    expect(anchors(noOmni, 'Trace')).toHaveLength(1)

    const noHoneycomb = render(base({ analytics: { omni: analytics.omni } }))
    expect(anchors(noHoneycomb, 'Analytics')).toHaveLength(1)
    expect(anchors(noHoneycomb, 'Trace')).toHaveLength(0)

    const none = render(base({ analytics: undefined }))
    expect(anchors(none, 'Analytics')).toHaveLength(0)
    expect(anchors(none, 'Trace')).toHaveLength(0)
  })

  it('renders neither link for a city-scoped crew, even though it names the HQ rig', () => {
    // gascity-service resolves the city root through a rig, so a city-scoped
    // response still carries rigName; filtering every member on it would match
    // nothing.
    const response = base().response as GasCityCrew
    const markup = render(base({ response: { ...response, scope: 'city', rigName: 'hq' } }))
    expect(anchors(markup, 'Analytics')).toHaveLength(0)
    expect(anchors(markup, 'Trace')).toHaveLength(0)
  })

  it('gives the city lead in a rig workspace no Trace link unless gc projects its rig', () => {
    const mayor = (rig?: string) =>
      member({
        key: 'gc-9',
        tier: 'lead',
        label: 'mayor',
        target: 'mayor',
        cityLead: true,
        session: { id: 'gc-9', name: 'mayor', state: 'active', ...(rig ? { rig } : {}) },
      })
    const unprojected = render(base({ response: crew([mayor()]) }))
    expect(anchors(unprojected, 'Trace')).toHaveLength(0)
    expect(anchors(unprojected, 'Analytics')).toHaveLength(1)

    const projected = render(base({ response: crew([mayor('gas-city')]) }))
    const [traceTag] = anchors(projected, 'Trace')
    expect(filtersOf(hrefOf(traceTag as string))).toEqual({
      'gen_ai.agent.name': 'gas-city.mayor',
      'gc.rig': 'gas-city',
    })
  })

  it('prefers the rig gc projects on a session over the workspace rig', () => {
    const markup = render(
      base({
        response: crew([
          member({ session: { id: 'gc-1', name: 'x', state: 'active', template: 'polecat', rig: 'other' } }),
        ]),
      }),
    )
    const [traceTag] = anchors(markup, 'Trace')
    expect(filtersOf(hrefOf(traceTag as string))).toEqual({
      'gen_ai.agent.name': 'other.polecat',
      'gc.rig': 'other',
    })
  })
})
