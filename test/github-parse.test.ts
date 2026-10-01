import * as hegel from '@hegeldev/hegel'
import * as generators from '@hegeldev/hegel/generators'
import { describe, expect, it } from 'vitest'

import {
  classifyGhFailure,
  githubRemoteRepos,
  githubRemoteRepositoryMap,
  parseBranchUpstreams,
  parsePullsOutput,
  parseRepoView,
} from '../src/main/github/github-parse'
import { openFeedbackCount, type FeedbackNode } from '../src/main/github/pr-feedback'

const HEAD_AT = '2026-09-30T12:00:00Z'
const BEFORE = '2026-09-30T11:00:00Z'
const AFTER = '2026-09-30T13:00:00Z'

function feedbackNode(overrides: Partial<FeedbackNode> = {}): FeedbackNode {
  return {
    headCommittedAt: HEAD_AT,
    threads: [],
    reviews: [],
    comments: [],
    ...overrides,
  }
}

function prNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: 'Add the panel',
    url: 'https://github.com/acme/widgets/pull/7',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/panel',
    updatedAt: AFTER,
    reviewDecision: 'REVIEW_REQUIRED',
    author: { login: 'stephanie' },
    headRepository: { nameWithOwner: 'acme/widgets' },
    commits: {
      nodes: [
        { commit: { committedDate: HEAD_AT, statusCheckRollup: { state: 'SUCCESS' } } },
      ],
    },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  }
}

const LOCAL_REPOS: ReadonlySet<string> = new Set(['acme/widgets', 'stephanie/widgets'])

function parse(stdout: string): ReturnType<typeof parsePullsOutput> {
  return parsePullsOutput(stdout, LOCAL_REPOS)
}

function graphqlOutput(data: Record<string, unknown>): string {
  return JSON.stringify({ data })
}

describe('openFeedbackCount', () => {
  it('counts unresolved threads that are not outdated', () => {
    const node = feedbackNode({
      threads: [
        { isResolved: false, isOutdated: false },
        { isResolved: true, isOutdated: false },
        { isResolved: false, isOutdated: true },
      ],
    })
    expect(openFeedbackCount(node, 'stephanie')).toBe(1)
  })

  it('drops review bodies and comments that a later push superseded', () => {
    const node = feedbackNode({
      reviews: [
        {
          state: 'COMMENTED',
          body: 'old',
          submittedAt: BEFORE,
          author: 'ben',
          bot: false,
        },
        {
          state: 'COMMENTED',
          body: 'new',
          submittedAt: AFTER,
          author: 'ben',
          bot: false,
        },
      ],
      comments: [
        { createdAt: BEFORE, author: 'ben', bot: false },
        { createdAt: AFTER, author: 'ben', bot: false },
      ],
    })
    expect(openFeedbackCount(node, 'stephanie')).toBe(2)
  })

  it('ignores the viewer, empty review bodies, approvals and bot discussion', () => {
    const node = feedbackNode({
      reviews: [
        {
          state: 'COMMENTED',
          body: 'mine',
          submittedAt: AFTER,
          author: 'stephanie',
          bot: false,
        },
        {
          state: 'COMMENTED',
          body: '   ',
          submittedAt: AFTER,
          author: 'ben',
          bot: false,
        },
        {
          state: 'APPROVED',
          body: 'lgtm',
          submittedAt: AFTER,
          author: 'ben',
          bot: false,
        },
        {
          state: 'CHANGES_REQUESTED',
          body: 'fix',
          submittedAt: AFTER,
          author: 'copilot',
          bot: true,
        },
      ],
      comments: [
        { createdAt: AFTER, author: 'stephanie', bot: false },
        { createdAt: AFTER, author: 'dependabot', bot: true },
      ],
    })
    expect(openFeedbackCount(node, 'stephanie')).toBe(1)
  })

  it('keeps everything when the head commit date is unknown', () => {
    const node = feedbackNode({
      headCommittedAt: undefined,
      comments: [{ createdAt: BEFORE, author: 'ben', bot: false }],
    })
    expect(openFeedbackCount(node, 'stephanie')).toBe(1)
  })

  it('never exceeds the feedback it was given and never goes negative', () => {
    hegel.test((testCase) => {
      const threads = testCase.draw(
        generators.arrays(
          generators.record({
            isResolved: generators.booleans(),
            isOutdated: generators.booleans(),
          }),
          { maxSize: 8 },
        ),
      )
      const comments = testCase.draw(
        generators.arrays(
          generators.record({
            createdAt: generators.sampledFrom([BEFORE, AFTER]),
            author: generators.sampledFrom(['ben', 'stephanie', 'bot']),
            bot: generators.booleans(),
          }),
          { maxSize: 8 },
        ),
      )
      const count = openFeedbackCount(feedbackNode({ threads, comments }), 'stephanie')
      expect(count).toBeGreaterThanOrEqual(0)
      expect(count).toBeLessThanOrEqual(threads.length + comments.length)
    })
  })
})

describe('parsePullsOutput', () => {
  it('normalizes the three lists and the viewer', () => {
    const parsed = parse(
      graphqlOutput({
        viewer: { login: 'stephanie' },
        repository: { branch: { nodes: [prNode()] } },
        mine: { nodes: [prNode({ number: 8, isDraft: true, reviewDecision: null })] },
        review: {
          nodes: [
            prNode({
              number: 9,
              author: { login: 'ben' },
              commits: {
                nodes: [
                  {
                    commit: {
                      committedDate: HEAD_AT,
                      statusCheckRollup: { state: 'FAILURE' },
                    },
                  },
                ],
              },
            }),
          ],
        },
      }),
    )
    expect(parsed.viewer).toBe('stephanie')
    expect(parsed.branchPulls).toEqual([
      {
        number: 7,
        title: 'Add the panel',
        url: 'https://github.com/acme/widgets/pull/7',
        state: 'open',
        draft: false,
        headRef: 'feat/panel',
        headRepo: 'acme/widgets',
        author: 'stephanie',
        updatedAt: AFTER,
        checks: 'passing',
        review: 'review-required',
        openFeedback: 0,
      },
    ])
    expect(parsed.authored.map((pull) => [pull.number, pull.draft, pull.review])).toEqual(
      [[8, true, 'none']],
    )
    expect(parsed.reviewRequested.map((pull) => [pull.number, pull.checks])).toEqual([
      [9, 'failing'],
    ])
  })

  it('maps rollup, review and state vocabularies', () => {
    const pull = (overrides: Record<string, unknown>) =>
      parse(
        graphqlOutput({ viewer: { login: 'v' }, mine: { nodes: [prNode(overrides)] } }),
      ).authored[0]
    const rollup = (state: string | null) => ({
      nodes: [
        {
          commit: {
            committedDate: HEAD_AT,
            statusCheckRollup: state === null ? null : { state },
          },
        },
      ],
    })
    expect(pull({ commits: rollup('PENDING') })?.checks).toBe('pending')
    expect(pull({ commits: rollup('EXPECTED') })?.checks).toBe('pending')
    expect(pull({ commits: rollup('ERROR') })?.checks).toBe('failing')
    expect(pull({ commits: rollup(null) })?.checks).toBe('none')
    expect(pull({ reviewDecision: 'APPROVED' })?.review).toBe('approved')
    expect(pull({ reviewDecision: 'CHANGES_REQUESTED' })?.review).toBe(
      'changes-requested',
    )
    expect(pull({ state: 'MERGED' })?.state).toBe('merged')
    expect(pull({ state: 'CLOSED' })?.state).toBe('closed')
  })

  it('counts open feedback from bot typename and the viewer login', () => {
    const parsed = parse(
      graphqlOutput({
        viewer: { login: 'stephanie' },
        mine: {
          nodes: [
            prNode({
              reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] },
              comments: {
                nodes: [
                  { createdAt: AFTER, author: { __typename: 'Bot', login: 'ci' } },
                  { createdAt: AFTER, author: { __typename: 'User', login: 'ben' } },
                  { createdAt: AFTER, author: null },
                ],
              },
            }),
          ],
        },
      }),
    )
    expect(parsed.authored[0]?.openFeedback).toBe(3)
  })

  it('keeps only branch pulls whose head lives in a local remote', () => {
    const parsed = parse(
      graphqlOutput({
        viewer: { login: 'stephanie' },
        repository: {
          branch: {
            nodes: [
              prNode({
                number: 1,
                headRepository: { nameWithOwner: 'Stephanie/Widgets' },
              }),
              prNode({
                number: 2,
                headRepository: { nameWithOwner: 'stranger/widgets' },
              }),
              prNode({ number: 3, headRepository: null }),
            ],
          },
        },
      }),
    )
    expect(parsed.branchPulls.map((pull) => pull.number)).toEqual([1])
  })

  it('counts open feedback only on the viewer own pulls', () => {
    const parsed = parse(
      graphqlOutput({
        viewer: { login: 'stephanie' },
        review: {
          nodes: [
            prNode({
              author: { login: 'ben' },
              reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] },
              comments: {
                nodes: [
                  { createdAt: AFTER, author: { __typename: 'User', login: 'ben' } },
                ],
              },
            }),
          ],
        },
      }),
    )
    expect(parsed.reviewRequested[0]?.openFeedback).toBe(0)
  })

  it('skips search hits that are not pull requests and tolerates a missing repository', () => {
    const parsed = parse(
      graphqlOutput({
        viewer: { login: 'v' },
        repository: null,
        mine: { nodes: [{}, prNode({ number: 3 }), null] },
        review: { nodes: [] },
      }),
    )
    expect(parsed.branchPulls).toEqual([])
    expect(parsed.authored.map((pull) => pull.number)).toEqual([3])
  })

  it('rejects output without data or with GraphQL errors', () => {
    expect(() => parse('not json')).toThrow()
    expect(() => parse(JSON.stringify({ errors: [{ message: 'boom' }] }))).toThrow(/boom/)
  })

  it('never throws on arbitrary JSON objects under data', () => {
    hegel.test((testCase) => {
      const value = testCase.draw(
        generators.oneOf<unknown>(
          generators.integers(),
          generators.text({ maxSize: 10 }),
          generators.booleans(),
          generators.just(null),
          generators.arrays(generators.integers(), { maxSize: 3 }),
        ),
      )
      const parsed = parse(
        graphqlOutput({ viewer: value, repository: value, mine: value, review: value }),
      )
      expect(parsed.authored).toEqual([])
    })
  })
})

describe('checkout tracking parsers', () => {
  it('resolves only an exact named GitHub remote and upstream ref', () => {
    const remotes = githubRemoteRepositoryMap(
      'origin\thttps://github.com/acme/widgets (fetch)\n' +
        'origin\tgit@github.com:acme/widgets.git (push)\n' +
        'fork\thttps://github.com/other/widgets (fetch)\n',
    )
    expect(
      parseBranchUpstreams(
        'feat/panel\0origin\0refs/heads/feat/panel\0\n' +
          'feat/other\0fork\0refs/heads/feat/other\0\n' +
          'local\0.\0refs/heads/local\0',
        remotes,
      ),
    ).toEqual(
      new Map([
        [
          'feat/panel',
          { branch: 'feat/panel', headRepo: 'acme/widgets', headRef: 'feat/panel' },
        ],
        [
          'feat/other',
          { branch: 'feat/other', headRepo: 'other/widgets', headRef: 'feat/other' },
        ],
        ['local', { branch: 'local' }],
      ]),
    )
  })

  it('omits repository identity for ambiguous and unknown remotes', () => {
    const remotes = githubRemoteRepositoryMap(
      'origin\thttps://github.com/acme/widgets (fetch)\n' +
        'origin\thttps://github.com/other/widgets (fetch)\n' +
        'origin\thttps://github.com/other/widgets (push)\n' +
        'upstream\thttps://gitlab.com/acme/widgets (fetch)\n',
    )
    expect(
      parseBranchUpstreams(
        'a\0origin\0refs/heads/a\0\nb\0upstream\0refs/heads/b\0\n',
        remotes,
      ),
    ).toEqual(
      new Map([
        ['a', { branch: 'a' }],
        ['b', { branch: 'b' }],
      ]),
    )
  })
})

describe('parseRepoView', () => {
  it('accepts owner/name and rejects anything else', () => {
    expect(parseRepoView('{"nameWithOwner":"jarmak-personal/hvir"}')).toBe(
      'jarmak-personal/hvir',
    )
    expect(() => parseRepoView('{"nameWithOwner":"a/b c"}')).toThrow()
    expect(() => parseRepoView('{}')).toThrow()
  })
})

describe('githubRemoteRepos', () => {
  it('reads owner/name from https, ssh and scp-style github.com remotes', () => {
    expect([
      ...githubRemoteRepos(
        [
          'origin\thttps://github.com/Acme/Widgets (fetch)',
          'fork\tgit@github.com:stephanie/widgets.git (fetch)',
          'fork\tgit@github.com:stephanie/widgets.git (push)',
          'mirror\tssh://git@github.com/acme/tools.git/ (push)',
        ].join('\n'),
      ),
    ]).toEqual(['acme/widgets', 'stephanie/widgets', 'acme/tools'])
  })

  it('ignores other hosts and look-alike domains', () => {
    expect(githubRemoteRepos('origin\thttps://gitlab.com/a/b (fetch)\n').size).toBe(0)
    expect(
      githubRemoteRepos('origin\thttps://github.com.evil.io/a/b (fetch)\n').size,
    ).toBe(0)
    expect(githubRemoteRepos('').size).toBe(0)
  })
})

describe('classifyGhFailure', () => {
  it('names the actionable failures', () => {
    expect(
      classifyGhFailure('To get started with GitHub CLI, please run:  gh auth login')
        .reason,
    ).toBe('gh-unauthenticated')
    expect(classifyGhFailure('API rate limit exceeded for user').reason).toBe(
      'rate-limited',
    )
    expect(
      classifyGhFailure(
        'none of the git remotes configured for this repository point to a known GitHub host',
      ).reason,
    ).toBe('no-github-repo')
    expect(classifyGhFailure('something else').reason).toBe('error')
  })
})
