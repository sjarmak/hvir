import { readFile } from 'node:fs/promises'

import type { ProjectHost } from '../src/main/project-host/project-host.ts'
import { SshHost } from '../src/main/project-host/ssh-host.ts'
import type { SshHostOptions } from '../src/main/project-host/ssh-host-options.ts'
import {
  LocalSshIdentitySource,
  type SshIdentitySource,
} from '../src/main/project-host/ssh-identity-source.ts'
import type { RealHostSshConfiguration } from './real-host-ssh-contract.mts'

/** Secrets supplied through the environment, removed from it once taken. */
export interface RealHostSshSecrets {
  readonly inlinePrivateKey: Buffer | undefined
  readonly passphrase: string | undefined
}

type Tuning = Omit<SshHostOptions, 'config' | 'identitySource' | 'trust' | 'prompter'>

/** Takes the private key and passphrase out of the environment so children never see them. */
export function takeRealHostSshSecrets(
  environment: NodeJS.ProcessEnv,
): RealHostSshSecrets {
  const inlinePrivateKey = environment.HVIR_REAL_SSH_PRIVATE_KEY
    ? Buffer.from(environment.HVIR_REAL_SSH_PRIVATE_KEY, 'utf8')
    : undefined
  const passphrase = environment.HVIR_REAL_SSH_PASSPHRASE
  delete environment.HVIR_REAL_SSH_PRIVATE_KEY
  delete environment.HVIR_REAL_SSH_PASSPHRASE
  return { inlinePrivateKey, passphrase }
}

/**
 * An SSH host for one explicit target: the host key is pinned, the only identity is the
 * configured one, and the only prompt answered is that identity's passphrase.
 */
export function createRealHostSshHost(
  configuration: RealHostSshConfiguration,
  secrets: RealHostSshSecrets,
  tuning: Tuning = {},
): SshHost {
  const passphrase = configuration.hasPassphrase ? secrets.passphrase : undefined
  return new SshHost({
    ...tuning,
    config: {
      alias: configuration.alias,
      hostname: configuration.hostname,
      user: configuration.user,
      port: configuration.port,
      identityFiles: [],
    },
    identitySource: realHostSshIdentitySource(configuration, secrets.inlinePrivateKey),
    trust: {
      trustedHostKey: () => configuration.trustedHostKey,
      rememberHostKey: () => Promise.reject(new Error('Real-host SSH trust is pinned')),
    },
    prompter: {
      prompt: (request) =>
        Promise.resolve(
          request.kind === 'passphrase' && passphrase ? [passphrase] : undefined,
        ),
    },
  })
}

function realHostSshIdentitySource(
  configuration: RealHostSshConfiguration,
  inlinePrivateKey: Buffer | undefined,
): SshIdentitySource {
  if (configuration.credential.kind === 'file') {
    const path = configuration.credential.path
    const local: Pick<ProjectHost, 'readFile'> = {
      readFile: (qualifiedPath) => readFile(qualifiedPath.path),
    }
    return new LocalSshIdentitySource(local, [path])
  }
  const path = 'explicit-real-host-identity'
  return {
    candidatePaths: [path],
    acquire(candidate, signal) {
      if (candidate !== path || signal.aborted) return Promise.resolve(undefined)
      let privateKey = inlinePrivateKey ? Buffer.from(inlinePrivateKey) : undefined
      if (!privateKey) return Promise.resolve(undefined)
      return Promise.resolve({
        path,
        get privateKey() {
          if (!privateKey) throw new Error('SSH identity lease is released')
          return privateKey
        },
        release() {
          privateKey?.fill(0)
          privateKey = undefined
        },
      })
    },
  }
}
