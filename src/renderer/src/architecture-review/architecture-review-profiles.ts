import type { HarnessProfile, HarnessProviderDescriptor } from '../../../shared'

export function selectArchitectureReviewProfiles(
  providers: readonly HarnessProviderDescriptor[],
  profiles: readonly HarnessProfile[],
): readonly HarnessProfile[] {
  const providerIds = new Set(
    providers
      .filter((provider) => provider.architectureExplanation)
      .map((provider) => provider.id),
  )
  return profiles.filter(
    (profile) =>
      providerIds.has(profile.providerId) &&
      profile.executable.kind === 'provider-default' &&
      profile.args.length === 0,
  )
}

export function selectArchitectureReviewTemplateProvider(
  providers: readonly HarnessProviderDescriptor[],
): HarnessProviderDescriptor | undefined {
  return providers.find(
    (provider) =>
      provider.architectureExplanation && !provider.default && provider.profileTemplate,
  )
}
