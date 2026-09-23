import { expect, it } from 'vitest'
import { codexProvider } from '../src/main/harness/providers/codex'
import { claudeCodeProvider } from '../src/main/harness/providers/claude-code'
import { plainShellProvider } from '../src/main/harness/providers/shell'
import { composeArchitectureReviewLaunch } from '../src/main/harness/architecture-review-launch'
import { localPath } from '../src/shared/host-path'
const context = {
  sessionId: 'review-session',
  cwd: localPath('/repo'),
  defaultShell: '/bin/sh',
}
it('keeps evidence in a single provider-owned prompt argument in a fresh native session', () => {
  for (const provider of [codexProvider, claudeCodeProvider]) {
    const spec = provider.launch(context)
    const body = 'Review before\nafter $(touch /no)'
    const result = composeArchitectureReviewLaunch(provider, spec, body)
    expect(result.file).toBe(spec.file)
    expect(result.args.slice(0, spec.args.length)).toEqual(spec.args)
    expect(result.args.slice(-2)).toEqual(['--', body])
  }
})
it('refuses unsupported providers instead of delivering shell input', () => {
  expect(() =>
    composeArchitectureReviewLaunch(
      plainShellProvider,
      plainShellProvider.launch(context),
      'body',
    ),
  ).toThrow(/architecture review/)
})
