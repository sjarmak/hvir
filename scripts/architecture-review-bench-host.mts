import { LocalHost } from '../src/main/project-host/local-host'
import type { ProjectHost } from '../src/main/project-host/project-host'
import {
  REAL_HOST_SSH_ENVIRONMENT_KEYS,
  readRealHostSshConfiguration,
} from './real-host-ssh-contract.mts'
import { createRealHostSshHost, takeRealHostSshSecrets } from './real-host-ssh-host.mts'

export type BenchHostKind = 'local' | 'ssh'

/** The host a bench scans through, what it reports as the target, and how to release it. */
export interface BenchHost {
  readonly host: ProjectHost
  readonly target: string
  readonly dispose: () => Promise<void>
}

export type BenchHostOpener = (kind: BenchHostKind) => Promise<BenchHost>

const SSH_TARGET_HELP =
  `set ${REAL_HOST_SSH_ENVIRONMENT_KEYS.filter((key) => !/PRIVATE_KEY|IDENTITY_FILE|PASSPHRASE/.test(key)).join(', ')}` +
  ' and one of HVIR_REAL_SSH_PRIVATE_KEY or HVIR_REAL_SSH_IDENTITY_FILE'

/**
 * The local host, or one explicit SSH target described by the real-host acceptance
 * environment contract: pinned host key, one identity, no interactive prompts.
 */
export async function openArchitectureBenchHost(
  kind: BenchHostKind,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BenchHost> {
  if (kind === 'local') {
    const host = new LocalHost()
    return { host, target: 'local', dispose: () => host.dispose() }
  }
  const configuration = readRealHostSshConfiguration(environment)
  if (configuration.kind === 'unavailable')
    throw new Error(`An SSH bench needs an explicit pinned target: ${SSH_TARGET_HELP}`)
  if (configuration.kind === 'invalid')
    throw new Error(`Invalid SSH bench target (${configuration.fields.join(', ')})`)
  const secrets = takeRealHostSshSecrets(environment)
  const host = createRealHostSshHost(configuration.value, secrets)
  const dispose = async () => {
    try {
      await host.dispose()
    } finally {
      secrets.inlinePrivateKey?.fill(0)
    }
  }
  try {
    await host.connect()
  } catch (error) {
    await dispose()
    throw error
  }
  const { user, hostname, port } = configuration.value
  return { host, target: `${user}@${hostname}:${port}`, dispose }
}
