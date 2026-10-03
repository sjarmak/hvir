import {
  asHarnessProviderId,
  asHarnessProfileId,
  type HarnessContextPressurePolicy,
} from '../../../shared'
import type { HarnessProvider, HarnessLaunchSpec } from '../harness-provider-contract'
import { configureClaudeComposerSubmit } from '../claude-keybindings'
import {
  observeClaudeContext,
  observeClaudeUsage,
  snapshotClaudeUsage,
} from '../claude-context-telemetry'
import { claudeResumeAvailability } from '../claude-session-recovery'
import { versionProbe } from '../harness-provider-probes'
import {
  pathImagePasteContract,
  documentReviewInsertContract,
} from '../harness-composer-contracts'

const CLAUDE_IDENTITY_DESCRIPTORS = [
  { id: 'claude-1', displayName: 'claude-1', configHomeSegment: 'account1' },
  { id: 'claude-2', displayName: 'claude-2', configHomeSegment: 'account2' },
  { id: 'claude-3', displayName: 'claude-3', configHomeSegment: 'account3' },
  { id: 'claude-4', displayName: 'claude-4', configHomeSegment: 'account4' },
  { id: 'claude-5', displayName: 'claude-5', configHomeSegment: 'account5' },
  { id: 'claude-omni', displayName: 'claude-omni', configHomeSegment: 'account-omni' },
]
const CLAUDE_IDENTITIES = CLAUDE_IDENTITY_DESCRIPTORS.map(({ id, displayName }) => ({
  id,
  displayName,
}))

const CLAUDE_CONTEXT_PRESSURE: HarnessContextPressurePolicy = {
  assumedWindowTokens: 1_000_000,
  warningPercent: 20,
  criticalPercent: 40,
}

const claudeCodeReviewInsert = documentReviewInsertContract(() => claudeCodeProvider)

export const claudeCodeProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('claude-code'),
    displayName: 'Claude Code',
    sessionKind: 'agent',
    contextPresentation: 'pressure',
    contextPressure: CLAUDE_CONTEXT_PRESSURE,
    modifiedKeyProtocol: 'modify-other-keys',
    metaEnterAliasesControl: true,
  },
  profile: {
    version: 4,
    defaultProfile: {
      id: asHarnessProfileId('claude-code-default'),
      displayName: 'Claude Code',
      description: 'Claude Code with exact hvir-managed session recovery.',
    },
    reservedArguments: ['--session-id', '--resume', '--continue', '--fork-session'],
    reservedEnvironmentKeys: ['CLAUDE_CONFIG_DIR'],
    artifactEnvironmentKeys: ['CLAUDE_CONFIG_DIR'],
    artifactExecutable: true,
    artifactPathBindings: [],
    identities: CLAUDE_IDENTITIES,
    async applyIdentity(host, identityId, spec) {
      const identity = CLAUDE_IDENTITY_DESCRIPTORS.find(({ id }) => id === identityId)
      if (!identity) throw new Error(`Unknown Claude identity '${identityId}'`)
      const result = await host.exec('printenv', ['HOME'], {
        loginShell: true,
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      })
      const home = result.stdout.trim()
      if (result.code !== 0 || !home.startsWith('/')) {
        throw new Error('Claude identity requires an absolute home directory')
      }
      const configDirectory = `${home}/.claude-homes/${identity.configHomeSegment}/.claude`
      return {
        spec: {
          ...spec,
          env: {
            ...spec.env,
            CLAUDE_CONFIG_DIR: configDirectory,
          },
        },
        previewEnvironment: [
          {
            name: 'CLAUDE_CONFIG_DIR',
            operation: 'set',
            displayValue: configDirectory,
            redacted: false,
          },
        ],
      }
    },
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
  },
  supportsResume: true,
  sessionIdentity: 'preassigned',
  telemetry: { observe: observeClaudeContext },
  usageTelemetry: { observe: observeClaudeUsage },
  usageSnapshots: { snapshot: snapshotClaudeUsage },
  resumeValidation: { availability: claudeResumeAvailability },
  probe: versionProbe('preassigned', true, 'pressure', {
    contextPressure: CLAUDE_CONTEXT_PRESSURE,
    reviewInsert: claudeCodeReviewInsert,
    supportsExactForkVersion: supportsClaudeExactForkVersion,
    supportsCompactionObservationVersion,
  }),
  composerConfiguration: { configure: configureClaudeComposerSubmit },
  remoteImagePaste: pathImagePasteContract(),
  documentReviewInsert: claudeCodeReviewInsert,

  architectureReviewLaunch: (spec, body) => ({
    ...spec,
    args: [...spec.args, '--', body],
  }),

  architectureExplanation: (spec) => ({
    ...spec,
    args: [
      '--print',
      '--no-session-persistence',
      '--safe-mode',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--output-format',
      'text',
    ],
  }),

  launch(ctx): HarnessLaunchSpec {
    return {
      file: 'claude',
      args: ['--session-id', ctx.sessionId],
      shellEnvironment: true,
    }
  },

  resume(ctx): HarnessLaunchSpec {
    return {
      file: 'claude',
      args: ['--resume', ctx.sessionId],
      shellEnvironment: true,
    }
  },

  fork(ctx): HarnessLaunchSpec {
    if (!ctx.parentSessionId)
      throw new Error('Claude Code fork requires an exact parent id')
    return {
      file: 'claude',
      args: [
        '--session-id',
        ctx.sessionId,
        '--resume',
        ctx.parentSessionId,
        '--fork-session',
      ],
      shellEnvironment: true,
    }
  },
}

function supportsClaudeExactForkVersion(version: string | undefined): boolean {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/.exec(version ?? '')
  if (!match) return false
  const parts = match.slice(1).map(Number)
  return (
    parts[0]! > 2 ||
    (parts[0] === 2 && (parts[1]! > 1 || (parts[1] === 1 && parts[2]! >= 258)))
  )
}

function supportsCompactionObservationVersion(version: string | undefined): boolean {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/.exec(version ?? '')
  if (!match) return false
  const parts = match.slice(1).map(Number)
  return (
    parts[0]! > 2 ||
    (parts[0] === 2 && (parts[1]! > 1 || (parts[1] === 1 && parts[2]! >= 39)))
  )
}
