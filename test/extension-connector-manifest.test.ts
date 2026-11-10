import { describe, expect, it } from 'vitest'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { ACTION_BINDING_CAPABILITY } from '../src/shared/extensions/connectors'
import { EXTENSION_CAPABILITIES } from '../src/shared/extensions/contract'
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
    const manifest = (
      actions: unknown,
      declared = [action('record', false)],
      capabilities: string[] = ['connector.action-binding'],
    ) =>
      exampleManifest({
        optionalCapabilities: capabilities,
        actionConnectors: [{ ...connector, actions }],
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
      ['no action list', undefined, 'Invalid connector actions'],
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
        validateExtensionManifest(
          exampleManifest({
            optionalCapabilities: ['connector.action-binding'],
            actionConnectors: [{ ...connector, actions: ['record'] }],
          }),
        ),
      ).toThrow('Connector actions must name declared actions')
    })
  })
  describe('action-binding negotiation', () => {
    const action = {
      id: 'record',
      title: 'record',
      view: 'reference',
      agents: false,
      effects: { delete: false, replace: false },
    }
    const bound = { ...connector, id: 'bound', actions: ['record'] }
    it.each([
      [
        'required',
        { requiredCapabilities: ['presentation.read', 'connector.action-binding'] },
      ],
      ['optional', { optionalCapabilities: ['connector.action-binding'] }],
    ])(
      'admits action-bound connectors when the capability is %s',
      (_label, capabilities) => {
        const result = validateExtensionManifest(
          exampleManifest({
            ...capabilities,
            actionConnectors: [bound],
            actions: [action],
          }),
        )
        expect(result.manifest.connectors).toEqual([bound])
      },
    )
    it('refuses action-bound connectors without the negotiated capability', () => {
      expect(() =>
        validateExtensionManifest(
          exampleManifest({ actionConnectors: [bound], actions: [action] }),
        ),
      ).toThrow('require the connector.action-binding capability')
    })
    it('refuses an actions list on an ordinary connector, which an older host would ignore', () => {
      expect(() =>
        validateExtensionManifest(
          exampleManifest({
            optionalCapabilities: ['connector.action-binding'],
            connectors: [bound],
            actions: [action],
          }),
        ),
      ).toThrow('declared in actionConnectors')
    })
    it('counts both lists against one identity space and one limit', () => {
      const options = {
        optionalCapabilities: ['connector.action-binding'],
        actions: [action],
      }
      expect(() =>
        validateExtensionManifest(
          exampleManifest({
            ...options,
            connectors: [{ ...connector, id: 'bound' }],
            actionConnectors: [bound],
          }),
        ),
      ).toThrow('Duplicate connector')
      expect(() =>
        validateExtensionManifest(
          exampleManifest({
            ...options,
            connectors: Array.from({ length: 8 }, (_, index) => ({
              ...connector,
              id: `plain-${index}`,
            })),
            actionConnectors: [bound],
          }),
        ),
      ).toThrow('Too many connector')
    })
    it('treats the capability as part of the contract inventory', () => {
      expect(EXTENSION_CAPABILITIES).toContain(ACTION_BINDING_CAPABILITY)
    })
  })
})
