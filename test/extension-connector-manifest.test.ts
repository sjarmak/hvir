import { describe, expect, it } from 'vitest'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'

const connector = {
  id: 'installed-tool',
  description: 'Installed tool',
  context: 'application',
  timeoutMs: 180_000,
  outputBytes: 4 * 1024 * 1024,
  environment: ['TOOL_HOME'],
}
describe('connector declaration contract', () => {
  it('declares native requirements as data and reports unknown fields without granting them', () => {
    const result = validateExtensionManifest(
      exampleManifest({
        connectors: [{ ...connector, claimedReadOnly: true }],
        optionalCapabilities: [
          'connector.execute',
          'connector.output',
          'connector.status',
        ],
      }),
    )
    expect(result.manifest.connectors).toEqual([connector])
    expect(result.manifest.access).toEqual([])
    expect(result.warnings).toContain('Ignored unknown field: claimedReadOnly')
  })
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 180_001 },
    { outputBytes: 0 },
    { outputBytes: 4 * 1024 * 1024 + 1 },
    { context: 'selected-workspace' },
    { environment: ['TOKEN', 'TOKEN'] },
    { environment: ['INVALID;NAME'] },
  ])('rejects malformed finite declaration %j', (change) => {
    expect(() =>
      validateExtensionManifest(
        exampleManifest({ connectors: [{ ...connector, ...change }] }),
      ),
    ).toThrow()
  })
  it('rejects duplicate connector identities and more than eight declarations', () => {
    expect(() =>
      validateExtensionManifest(exampleManifest({ connectors: [connector, connector] })),
    ).toThrow('Duplicate connector')
    expect(() =>
      validateExtensionManifest(
        exampleManifest({ connectors: Array(9).fill(connector) }),
      ),
    ).toThrow('Too many connector')
  })
  describe('actions binding', () => {
    const action = (id: string, agents: boolean) => ({
      id,
      title: id,
      view: 'reference',
      agents,
      effects: { delete: false, replace: false },
    })
    const manifest = (actions: unknown, declared = [action('record', false)]) =>
      exampleManifest({
        connectors: [{ ...connector, actions }],
        actions: declared,
      })
    it('keeps a declared action list on the connector', () => {
      const result = validateExtensionManifest(manifest(['record']))
      expect(result.manifest.connectors).toEqual([{ ...connector, actions: ['record'] }])
    })
    it.each([
      ['an empty list', [], 'Invalid connector actions'],
      ['a non-array', 'record', 'Invalid connector actions'],
      ['a non-string entry', [1], 'Invalid connector actions'],
      ['duplicate names', ['record', 'record'], 'Invalid connector actions'],
      ['an unknown action', ['missing'], 'Connector actions must name declared actions'],
    ])('refuses %s', (_label, actions, message) => {
      expect(() => validateExtensionManifest(manifest(actions))).toThrow(message)
    })
    it('refuses an action that agents may run', () => {
      expect(() =>
        validateExtensionManifest(manifest(['record'], [action('record', true)])),
      ).toThrow('Connector actions must not be available to agents')
    })
    it('refuses actions when the manifest declares none', () => {
      expect(() =>
        validateExtensionManifest(exampleManifest({ connectors: [{ ...connector, actions: ['record'] }] })),
      ).toThrow('Connector actions must name declared actions')
    })
  })
})
