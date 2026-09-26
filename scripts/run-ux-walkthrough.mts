import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  invokeSmokeScenario,
  type SmokeScenarioInvocationOptions,
  type SmokeScenarioResult,
} from './run-smoke-scenarios.mts'

export const UX_WALKTHROUGH_JOURNEYS = ['architecture-live-review'] as const

export type UxWalkthroughJourney = (typeof UX_WALKTHROUGH_JOURNEYS)[number]

type InvokeWalkthroughSmoke = (
  scenario: 'ux-walkthrough',
  iteration: number,
  repetitionCount: number,
  options: SmokeScenarioInvocationOptions,
) => Promise<Omit<SmokeScenarioResult, 'scenario' | 'iteration' | 'repetitionCount'>>

export function parseUxWalkthroughArguments(
  values: readonly string[],
): UxWalkthroughJourney {
  if (values.length === 0) {
    throw new Error(`Choose one journey: ${UX_WALKTHROUGH_JOURNEYS.join(', ')}`)
  }
  if (values.length !== 1) throw new Error('Choose exactly one UX walkthrough journey')
  const value = values[0]!
  if (!UX_WALKTHROUGH_JOURNEYS.includes(value as UxWalkthroughJourney)) {
    throw new Error(
      `Unknown UX walkthrough journey '${value}'. Expected one of: ${UX_WALKTHROUGH_JOURNEYS.join(', ')}`,
    )
  }
  return value as UxWalkthroughJourney
}

export function uxWalkthroughEnvironment(
  environment: NodeJS.ProcessEnv,
  journey: UxWalkthroughJourney,
  outputDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    HVIR_UX_WALKTHROUGH: journey,
    HVIR_UX_WALKTHROUGH_DIR: outputDirectory,
  }
}

export async function runUxWalkthrough(options: {
  readonly journey: UxWalkthroughJourney
  readonly outputDirectory: string
  readonly environment: NodeJS.ProcessEnv
  readonly invoke?: InvokeWalkthroughSmoke
}): Promise<{
  readonly journey: UxWalkthroughJourney
  readonly outputDirectory: string
}> {
  const invoke = options.invoke ?? invokeSmokeScenario
  const result = await invoke('ux-walkthrough', 1, 1, {
    environment: uxWalkthroughEnvironment(
      options.environment,
      options.journey,
      options.outputDirectory,
    ),
    artifactDirectory: options.outputDirectory,
  })
  if (result.status !== 'passed') {
    throw new Error(
      `UX walkthrough smoke failed${result.error ? `: ${result.error}` : ''}`,
    )
  }
  return {
    journey: options.journey,
    outputDirectory: options.outputDirectory,
  }
}

async function main(): Promise<void> {
  const journey = parseUxWalkthroughArguments(process.argv.slice(2))
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const artifactRoot = join(repositoryRoot, 'ux-walkthrough-artifacts')
  const outputDirectory = join(artifactRoot, `${journey}-${randomUUID()}`)
  const result = await runUxWalkthrough({
    journey,
    outputDirectory,
    environment: process.env,
  })
  console.log(
    `[ux:walkthrough] ${result.journey} captured artifacts at ${result.outputDirectory}`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
