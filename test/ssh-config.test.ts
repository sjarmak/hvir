import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'

import { parseSshConfig } from '../src/main/project-host'

describe('SSH config parsing', () => {
  it('resolves aliases, wildcard defaults, ports, and identity expansion', () => {
    const hosts = parseSshConfig(
      `Host work
  HostName dev.example.test
  Port 2202
  IdentityFile ~/.ssh/%r@%h

Host *
  User picard
  IdentityFile ~/.ssh/common
`,
      '/home/picard',
    )
    expect(hosts).toEqual([
      {
        alias: 'work',
        hostname: 'dev.example.test',
        user: 'picard',
        port: 2202,
        identityFiles: [
          '/home/picard/.ssh/picard@dev.example.test',
          '/home/picard/.ssh/common',
        ],
      },
    ])
  })

  it('does not expose wildcard patterns as selectable aliases', () => {
    expect(parseSshConfig('Host *.internal\n  User deploy\n', '/home/me')).toEqual([])
  })

  it('resolves the configured identity agent for each alias', () => {
    expect(
      parseSshConfig(
        `Host work
  HostName dev.example.test
  User picard
  IdentityAgent ~/.ssh/agent-%r@%h
`,
        '/home/picard',
      ),
    ).toEqual([
      {
        alias: 'work',
        hostname: 'dev.example.test',
        user: 'picard',
        port: 22,
        identityFiles: [],
        identityAgent: '/home/picard/.ssh/agent-picard@dev.example.test',
      },
    ])
  })

  it('preserves an explicit identity-agent opt out', () => {
    expect(parseSshConfig('Host work\n  IdentityAgent none\n', '/home/me')).toEqual([
      expect.objectContaining({ identityAgent: null }),
    ])
  })

  it.each([
    ['SSH_AUTH_SOCK', { SSH_AUTH_SOCK: '/tmp/session-agent.sock' }, '/tmp/session-agent.sock'],
    ['$WORK_AGENT', { WORK_AGENT: '/tmp/work-agent.sock' }, '/tmp/work-agent.sock'],
    [
      '${AGENT_ROOT}/agent.sock',
      { AGENT_ROOT: '/tmp/work' },
      '/tmp/work/agent.sock',
    ],
    ['$MISSING_AGENT', {}, null],
  ] as const)(
    'resolves identity-agent environment form %s',
    (value, environment, identityAgent) => {
      expect(
        parseSshConfig(
          `Host work\n  IdentityAgent ${value}\n`,
          '/home/me',
          environment,
        ),
      ).toEqual([expect.objectContaining({ identityAgent })])
    },
  )

  it('expands identity-agent home, user, and host tokens for every alias', () =>
    hegel.test((testCase) => {
      const fragment = testCase
        .draw(gs.text({ maxSize: 24 }))
        .replace(/[^A-Za-z0-9]/g, 'x')
      const user = `user${fragment}`
      const hostname = `host${fragment}.example.test`

      expect(
        parseSshConfig(
          `Host work\n  HostName ${hostname}\n  User ${user}\n  IdentityAgent ~/.ssh/%r@%h.sock\n`,
          '/home/test',
        ),
      ).toEqual([
        expect.objectContaining({
          identityAgent: `/home/test/.ssh/${user}@${hostname}.sock`,
        }),
      ])
    }))
})
