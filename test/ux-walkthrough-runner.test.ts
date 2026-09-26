import { describe, expect, it, vi } from 'vitest'

import {
  parseUxWalkthroughArguments,
  runUxWalkthrough,
  uxWalkthroughEnvironment,
} from '../scripts/run-ux-walkthrough.mts'
import type { SmokeScenarioInvocationOptions } from '../scripts/run-smoke-scenarios.mts'

describe('UX walkthrough runner', () => {
  it('accepts the named architecture journey and rejects missing or unknown journeys', () => {
    expect(parseUxWalkthroughArguments(['architecture-live-review'])).toBe(
      'architecture-live-review',
    )
    expect(() => parseUxWalkthroughArguments([])).toThrow(
      'Choose one journey: architecture-live-review',
    )
    expect(() => parseUxWalkthroughArguments(['unknown'])).toThrow(
      "Unknown UX walkthrough journey 'unknown'",
    )
    expect(() =>
      parseUxWalkthroughArguments(['architecture-live-review', 'extra']),
    ).toThrow('Choose exactly one UX walkthrough journey')
  })

  it('passes the journey and artifact directory only to the walkthrough smoke process', () => {
    expect(
      uxWalkthroughEnvironment(
        {
          HVIR_SMOKE_SCENARIO: 'architecture-review',
          HVIR_UX_WALKTHROUGH: 'old',
          KEEP_ME: 'yes',
        },
        'architecture-live-review',
        '/tmp/walkthrough',
      ),
    ).toEqual({
      HVIR_SMOKE_SCENARIO: 'architecture-review',
      HVIR_UX_WALKTHROUGH: 'architecture-live-review',
      HVIR_UX_WALKTHROUGH_DIR: '/tmp/walkthrough',
      KEEP_ME: 'yes',
    })
  })

  it('returns the evidence location only after the smoke journey passes', async () => {
    const directory = '/tmp/hvir-ux-runner'
    const invoke = vi.fn(
      (
        _scenario: 'ux-walkthrough',
        _iteration: number,
        _repetitionCount: number,
        _options: SmokeScenarioInvocationOptions,
      ) => Promise.resolve({ status: 'passed' as const, exitCode: 0 }),
    )

    await expect(
      runUxWalkthrough({
        journey: 'architecture-live-review',
        outputDirectory: directory,
        environment: { KEEP_ME: 'yes' },
        invoke,
      }),
    ).resolves.toEqual({
      journey: 'architecture-live-review',
      outputDirectory: directory,
    })
    expect(invoke.mock.calls).toEqual([
      [
        'ux-walkthrough',
        1,
        1,
        {
          artifactDirectory: directory,
          environment: {
            KEEP_ME: 'yes',
            HVIR_UX_WALKTHROUGH: 'architecture-live-review',
            HVIR_UX_WALKTHROUGH_DIR: directory,
          },
        },
      ],
    ])
  })

  it('rejects failed attempts', async () => {
    const directory = '/tmp/hvir-ux-runner-fail'
    await expect(
      runUxWalkthrough({
        journey: 'architecture-live-review',
        outputDirectory: directory,
        environment: {},
        invoke: vi.fn(() => Promise.resolve({ status: 'failed' as const, exitCode: 1 })),
      }),
    ).rejects.toThrow('UX walkthrough smoke failed')
  })
})
