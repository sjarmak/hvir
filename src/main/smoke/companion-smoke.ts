import { localPath, type CompanionConfigView, type ProjectState } from '../../shared'
import type { ActionableAttentionSet } from '../attention/actionable-attention-set'
import { createCompanionAssetReader } from '../companion/companion-assets'
import type { CompanionStoreFile } from '../companion/companion-config-store'
import {
  installApplicationCompanion,
  type ApplicationCompanion,
  type CompanionOwnerDiagnostic,
} from '../companion/companion-owner'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { TerminalSessionRegistry } from '../terminal/session-registry'
import type { SmokeCleanup } from './cleanup'
import type { SmokeSessionsPorts } from './sessions-ports'

export interface SmokeCompanionOptions {
  readonly host: ProjectHost
  /** The built renderer directory; the scenario runs from a chunk, not main. */
  readonly rendererRoot: string
  readonly cleanup: SmokeCleanup
  readonly sessions: Pick<
    SmokeSessionsPorts,
    'observation' | 'transcripts' | 'companionSinks'
  >
  readonly actionable: ActionableAttentionSet
  readonly mirrors: Pick<PtySupervisor, 'attachMirror'>
  readonly terminals: Pick<TerminalSessionRegistry, 'get'>
  readonly projectState: () => ProjectState
  readonly publish: (view: CompanionConfigView) => void
}

/** One Push the owner sent, as the sink would have received it. */
export interface SmokePush {
  readonly url: string
  readonly body: string
}

export interface SmokeCompanion extends ApplicationCompanion {
  /** Every diagnostic the owner reported, in order; a scenario asserts on it. */
  readonly diagnostics: readonly CompanionOwnerDiagnostic[]
  /** Every Push the owner sent, in order; nothing leaves the process. */
  readonly pushes: readonly SmokePush[]
  readonly rendererRoot: string
}

/**
 * The production Companion owner over a settings file that exists only in
 * memory and no OS cipher: a scenario enables, pairs and revokes exactly as
 * the app does, while nothing touches the disk or the keychain of the machine
 * running it. The listener stays closed until a scenario enables it, the Push
 * fetch records instead of sending, and the cleanup ledger winds the owner
 * down the way the runtime would.
 */
export async function installSmokeCompanion(
  options: SmokeCompanionOptions,
): Promise<SmokeCompanion> {
  const diagnostics: CompanionOwnerDiagnostic[] = []
  const pushes: SmokePush[] = []
  const runtime = {
    own: <T>(
      label: string,
      resource: T,
      dispose: (resource: T) => void | Promise<void>,
    ) => {
      options.cleanup.defer(label, () => dispose(resource))
      return resource
    },
  }
  const companion = await installApplicationCompanion(runtime, {
    store: { host: memoryFile(), file: localPath('/companion.json'), secrets: noSecrets },
    assets: createCompanionAssetReader(options.host, options.rendererRoot),
    sessions: {
      observation: options.sessions.observation,
      transcripts: options.sessions.transcripts,
      sinks: options.sessions.companionSinks,
    },
    actionable: options.actionable,
    mirrors: options.mirrors,
    describe: {
      terminals: options.terminals,
      projects: { state: options.projectState },
      // The smoke build runs no supervisor, so a prompt line is never read.
      supervisor: {
        address: () => Promise.resolve({ ok: false, failure: { reason: 'disabled' } }),
      },
      external: { pendingSessions: () => [] },
    },
    publish: options.publish,
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic)
    },
    push: { fetch: recordingFetch(pushes) },
  })
  return { ...companion, diagnostics, pushes, rendererRoot: options.rendererRoot }
}

/** Records the sink request and answers 200; the smoke never reaches a network. */
function recordingFetch(pushes: SmokePush[]): typeof globalThis.fetch {
  return (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    pushes.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
    return Promise.resolve(new Response(null, { status: 200 }))
  }
}

const noSecrets = {
  isEncryptionAvailable: () => false,
  encryptString: (): Buffer => {
    throw new Error('smoke: no secret storage')
  },
  decryptString: (): string => {
    throw new Error('smoke: no secret storage')
  },
}

function memoryFile(): CompanionStoreFile {
  let text: string | undefined
  return {
    readTextFile: () =>
      text === undefined
        ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        : Promise.resolve(text),
    writeFile: (_path, data) => {
      text = String(data)
      return Promise.resolve()
    },
  }
}
