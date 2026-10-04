import { EventEmitter } from 'node:events'

import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import type { AnyAuthMethod, Client, ConnectConfig } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { SshHost } from '../src/main/project-host'
import { createTestSshHost } from './ssh-host-test-fixture'

describe('SshHost password-first authentication', () => {
  it('shows one password prompt across primary and pooled transports when both methods are offered', async () => {
    const prompt = vi.fn(() => Promise.resolve(['secret']))
    const clients: ScriptedClient[] = []
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt },
      clientFactory: () => {
        const client = scriptedClient(async (config) => {
          await expect(nextAuth(config, null)).resolves.toMatchObject({ type: 'none' })
          await expect(
            nextAuth(config, ['keyboard-interactive', 'password']),
          ).resolves.toMatchObject({ type: 'password', password: 'secret' })
        })
        clients.push(client)
        return client as unknown as Client
      },
    })
    vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })

    await host.connect()
    await openAuxiliaryTransport(host)
    await openAuxiliaryTransport(host)

    expect(clients).toHaveLength(3)
    expect(prompt).toHaveBeenCalledOnce()
    await host.dispose()
  })

  it('keeps keyboard-interactive answers uncached across transports', async () => {
    const prompt = vi.fn(() => Promise.resolve(['one-time answer']))
    const clients: ScriptedClient[] = []
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt },
      clientFactory: () => {
        const client = scriptedClient(async (config) => {
          await expect(nextAuth(config, null)).resolves.toMatchObject({ type: 'none' })
          const auth = await nextAuth(config, ['keyboard-interactive'])
          if (auth === false || auth.type !== 'keyboard-interactive') {
            throw new Error('Expected keyboard-interactive authentication')
          }
          await expect(
            answerKeyboardInteractive(auth, `Challenge ${clients.length}`),
          ).resolves.toEqual(['one-time answer'])
        })
        clients.push(client)
        return client as unknown as Client
      },
    })
    vi.spyOn(host, 'exec').mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    })

    await host.connect()
    await openAuxiliaryTransport(host)
    await openAuxiliaryTransport(host)

    expect(clients).toHaveLength(3)
    expect(prompt).toHaveBeenCalledTimes(3)
    await host.dispose()
  })

  it('drops a rejected cached password, prompts once, and does not loop', async () => {
    const prompt = vi
      .fn<() => Promise<readonly string[] | undefined>>()
      .mockResolvedValueOnce(['seed'])
      .mockResolvedValueOnce(['replacement'])
      .mockResolvedValueOnce(['next attempt'])
    const host = createTestSshHost({
      config: aliasConfig(),
      prompter: { prompt },
    })
    const seedAttempt = createCredentialAttempt(host)
    await expect(
      nextAuth(connectConfig(host, seedAttempt), ['password']),
    ).resolves.toMatchObject({ type: 'password', password: 'seed' })
    rememberSuccessfulCredentials(host, seedAttempt)
    const rejectedAttempt = createCredentialAttempt(host)
    const rejectedConfig = connectConfig(host, rejectedAttempt, 'pool')

    await expect(nextAuth(rejectedConfig, ['password'])).resolves.toMatchObject({
      type: 'password',
      password: 'seed',
    })
    await expect(nextAuth(rejectedConfig, ['password'])).resolves.toMatchObject({
      type: 'password',
      password: 'replacement',
    })
    await expect(nextAuth(rejectedConfig, ['password'])).resolves.toBe(false)
    await expect(
      nextAuth(connectConfig(host, createCredentialAttempt(host), 'pool'), ['password']),
    ).resolves.toMatchObject({ type: 'password', password: 'next attempt' })

    expect(prompt).toHaveBeenCalledTimes(3)
    await host.dispose()
  })

  it('prefers password for every generated transport count when both methods remain', async () => {
    await hegel.testAsync(async (testCase) => {
      const transportCount = testCase.draw(gs.integers({ minValue: 1, maxValue: 8 }))
      const prompt = vi.fn(() => Promise.resolve(['secret']))
      const host = createTestSshHost({
        config: aliasConfig(),
        prompter: { prompt },
      })
      try {
        for (let index = 0; index < transportCount; index++) {
          const attempt = createCredentialAttempt(host)
          await expect(
            nextAuth(connectConfig(host, attempt, 'pool'), [
              'keyboard-interactive',
              'password',
            ]),
          ).resolves.toMatchObject({ type: 'password', password: 'secret' })
          rememberSuccessfulCredentials(host, attempt)
        }
        expect(prompt).toHaveBeenCalledOnce()
      } finally {
        await host.dispose()
      }
    })
  })
})

interface TestCredentialAttempt {
  password?: string
}

type ScriptedClient = EventEmitter & {
  readonly connect: ReturnType<typeof vi.fn>
  readonly end: ReturnType<typeof vi.fn>
  readonly destroy: ReturnType<typeof vi.fn>
}

function scriptedClient(
  authenticate: (config: ConnectConfig) => Promise<void>,
): ScriptedClient {
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn((config: ConnectConfig) => {
      void authenticate(config).then(
        () => client.emit('ready'),
        (error: unknown) => client.emit('error', error),
      )
    }),
    end: vi.fn(() => client.emit('close')),
    destroy: vi.fn(() => client.emit('close')),
  })
  return client
}

function aliasConfig() {
  return {
    alias: 'example',
    hostname: 'example.test',
    user: 'picard',
    port: 22,
    identityFiles: [],
  }
}

function openAuxiliaryTransport(host: SshHost): Promise<Client> {
  return (
    host as unknown as {
      openAuxiliaryTransport(role: 'control'): Promise<Client>
    }
  ).openAuxiliaryTransport('control')
}

function createCredentialAttempt(host: SshHost): TestCredentialAttempt {
  return (
    host as unknown as {
      createCredentialAttempt(): TestCredentialAttempt
    }
  ).createCredentialAttempt()
}

function rememberSuccessfulCredentials(
  host: SshHost,
  attempt: TestCredentialAttempt,
): void {
  ;(
    host as unknown as {
      rememberSuccessfulCredentials(value: TestCredentialAttempt): void
    }
  ).rememberSuccessfulCredentials(attempt)
}

function connectConfig(
  host: SshHost,
  attempt: TestCredentialAttempt,
  purpose: 'primary' | 'pool' = 'primary',
): ConnectConfig {
  return (
    host as unknown as {
      connectConfig(
        value: TestCredentialAttempt,
        purpose: 'primary' | 'pool',
      ): ConnectConfig
    }
  ).connectConfig(attempt, purpose)
}

function nextAuth(
  config: ConnectConfig,
  methods: readonly string[] | null,
): Promise<AnyAuthMethod | false> {
  const handler = config.authHandler as unknown as (
    methods: readonly string[] | null,
    partial: boolean | null,
    next: (method: AnyAuthMethod | false) => void,
  ) => void
  return new Promise((resolve) =>
    handler(methods, methods === null ? null : false, resolve),
  )
}

function answerKeyboardInteractive(
  auth: Extract<AnyAuthMethod, { type: 'keyboard-interactive' }>,
  title: string,
): Promise<readonly string[]> {
  return new Promise((resolve) =>
    auth.prompt(
      title,
      'Enter the one-time answer',
      '',
      [{ prompt: 'Code', echo: false }],
      resolve,
    ),
  )
}
