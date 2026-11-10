import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ExtensionActionOwner,
  type ExtensionActionGuestPort,
} from '../src/main/extensions/action-owner'
import { validateCapturedExtension } from '../src/main/extensions/package-store'

const root = join(__dirname, '..', 'extensions', 'gascity')
const manifest = JSON.parse(readFileSync(join(root, 'hvir-extension.json'), 'utf8')) as {
  views: { entry: string; navigationIcon?: string }[]
  actions: { id: string; agents: boolean }[]
}

function gascityActivation() {
  const names = new Set<string>(['hvir-extension.json'])
  for (const view of manifest.views) {
    names.add(view.entry)
    if (view.navigationIcon) names.add(view.navigationIcon)
  }
  const files = new Map(
    [...names].map((name) => [
      name,
      name === 'hvir-extension.json'
        ? new TextEncoder().encode(JSON.stringify(manifest))
        : new Uint8Array(),
    ]),
  )
  const revision = validateCapturedExtension({ sourceIdentity: '1:1', files })
  return { installationId: 'one', generation: 'first', revision }
}

const answer = {
  decId: 'dec-r30f',
  letter: 'a',
  cardSha256: 'a'.repeat(64),
}

function owner() {
  const ports = {
    open: vi.fn(),
    dispatch: vi.fn(() => true),
    runnable: vi.fn(),
    cancelAction: vi.fn(),
    assertView: vi.fn(),
  } as unknown as ExtensionActionGuestPort
  return new ExtensionActionOwner(ports)
}

describe('Gas City answer-decision action', () => {
  it('is declared for people only', () => {
    expect(manifest.actions.find((item) => item.id === 'answer-decision')?.agents).toBe(false)
  })

  it('refuses an agent caller and admits a human caller', () => {
    const actions = owner()
    const activation = gascityActivation()
    expect(() =>
      actions.validateInvocation(activation, 'answer-decision', answer, 'agent'),
    ).toThrow('Action is unavailable to this caller')
    expect(
      actions.validateInvocation(activation, 'answer-decision', answer, 'human').id,
    ).toBe('answer-decision')
  })

  it('rejects input outside the declared three fields from a human caller', () => {
    const actions = owner()
    const activation = gascityActivation()
    expect(() =>
      actions.validateInvocation(
        activation,
        'answer-decision',
        { ...answer, extra: 'x' },
        'human',
      ),
    ).toThrow()
    expect(() =>
      actions.validateInvocation(
        activation,
        'answer-decision',
        { decId: answer.decId, letter: answer.letter },
        'human',
      ),
    ).toThrow()
  })
})
