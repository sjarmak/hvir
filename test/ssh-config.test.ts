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

  it('falls back to port 22 when the configured port is malformed', () => {
    expect(
      parseSshConfig('Host work\n  Port abc\n  IdentityFile ~/.ssh/key-%p\n', '/home/me'),
    ).toEqual([
      expect.objectContaining({
        port: 22,
        identityFiles: ['/home/me/.ssh/key-22'],
      }),
    ])
  })

  it('expands identity tokens once for files and agents', () => {
    expect(
      parseSshConfig(
        `Host work
  HostName dev.example.test
  User remote-user
  Port 2202
  IdentityFile /keys/%%d-%u@%h-%p
  IdentityAgent /tmp/%%h-%u@%r-%p.sock
`,
        '/home/local-user',
        { USER: 'local-user' },
      ),
    ).toEqual([
      {
        alias: 'work',
        hostname: 'dev.example.test',
        user: 'remote-user',
        port: 2202,
        identityFiles: ['/keys/%d-local-user@dev.example.test-2202'],
        identityAgent: '/tmp/%h-local-user@remote-user-2202.sock',
      },
    ])
  })

  it('expands the home-directory token in identity-file paths', () => {
    expect(parseSshConfig('Host work\n  IdentityFile %d/.ssh/key\n', '/home/me')).toEqual(
      [
        expect.objectContaining({
          identityFiles: ['/home/me/.ssh/key'],
        }),
      ],
    )
  })

  it('preserves environment syntax in identity-file paths', () => {
    expect(
      parseSshConfig('Host work\n  IdentityFile ${IDENTITY_ROOT}/key\n', '/home/me', {}),
    ).toEqual([
      expect.objectContaining({
        identityFiles: ['${IDENTITY_ROOT}/key'],
      }),
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

  it('treats the identity-agent opt out as case-sensitive', () => {
    expect(parseSshConfig('Host work\n  IdentityAgent NONE\n', '/home/me')).toEqual([
      expect.objectContaining({ identityAgent: 'NONE' }),
    ])
  })

  it('does not recursively expand identity-agent environment values', () => {
    expect(
      parseSshConfig(
        'Host work\n  HostName dev.example.test\n  IdentityAgent ${AGENT_ROOT}/%h.sock\n',
        '/home/me',
        { USER: 'local-user', AGENT_ROOT: '~/%u' },
      ),
    ).toEqual([expect.objectContaining({ identityAgent: '~/%u/dev.example.test.sock' })])
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

  it('expands identity-agent tokens exactly once for every alias', () =>
    hegel.test((testCase) => {
      const fragment = testCase
        .draw(gs.text({ maxSize: 24 }))
        .replace(/[^A-Za-z0-9]/g, 'x')
      const user = `user${fragment}`
      const localUser = `local${fragment}`
      const hostname = `host${fragment}.example.test`
      const port = testCase.draw(gs.integers({ minValue: 1, maxValue: 65_535 }))

      expect(
        parseSshConfig(
          `Host work\n  HostName ${hostname}\n  User ${user}\n  Port ${port}\n  IdentityAgent ~/.ssh/%%d-%u@%r-%h-%p.sock\n`,
          '/home/test',
          { USER: localUser },
        ),
      ).toEqual([
        expect.objectContaining({
          identityAgent: `/home/test/.ssh/%d-${localUser}@${user}-${hostname}-${port}.sock`,
        }),
      ])
    }))
})
