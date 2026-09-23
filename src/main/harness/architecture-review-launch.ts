import type { HarnessLaunchSpec, HarnessProvider } from './harness-provider-contract'
/** The native provider owns argv, never a terminal keystroke or shell command. */
export function composeArchitectureReviewLaunch(
  provider: HarnessProvider,
  spec: HarnessLaunchSpec,
  body: string,
): HarnessLaunchSpec {
  if (!provider.architectureReviewLaunch)
    throw new Error('This harness provider does not support architecture review launches')
  return provider.architectureReviewLaunch(spec, body)
}
