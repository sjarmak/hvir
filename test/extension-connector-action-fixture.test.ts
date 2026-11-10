import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'

const path = 'test/fixtures/extensions/action-bound/gascity-hvir-extension.json'
async function load(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}
it('validates the action-bound manifest shape the Gas City extension must declare', async () => {
  const { manifest, warnings } = validateExtensionManifest(await load())
  expect(warnings).toEqual([])
  expect(manifest.optionalCapabilities).toContain('connector.action-binding')
  expect(manifest.connectors?.find((entry) => entry.id === 'hvir-answer')).toMatchObject({
    actions: ['answer-decision'],
  })
  expect(
    manifest.connectors?.filter((entry) => entry.actions).map((entry) => entry.id),
  ).toEqual(['hvir-answer'])
})
it('keeps the bound connector out of the list an older host reads as ordinary connectors', async () => {
  const raw = await load()
  const ordinary = raw['connectors'] as { id: string; actions?: unknown }[]
  expect(ordinary.map((entry) => entry.id)).not.toContain('hvir-answer')
  expect(ordinary.some((entry) => entry.actions !== undefined)).toBe(false)
  expect((raw['actionConnectors'] as { id: string }[]).map((entry) => entry.id)).toEqual([
    'hvir-answer',
  ])
})
it('refuses the same manifest when it leaves the capability undeclared', async () => {
  const raw = await load()
  const optional = (raw['optionalCapabilities'] as string[]).filter(
    (entry) => entry !== 'connector.action-binding',
  )
  expect(() =>
    validateExtensionManifest({ ...raw, optionalCapabilities: optional }),
  ).toThrow('connector.action-binding')
})
it('refuses the answer connector as an ordinary connector that carries actions', async () => {
  const raw = await load()
  const bound = (raw['actionConnectors'] as unknown[])[0]
  expect(() =>
    validateExtensionManifest({
      ...raw,
      connectors: [...(raw['connectors'] as unknown[]), bound],
      actionConnectors: undefined,
    }),
  ).toThrow('declared in actionConnectors')
})
