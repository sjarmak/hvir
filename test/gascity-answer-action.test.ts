import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  ExtensionActionOwner,
  type ExtensionActionGuestPort,
} from '../src/main/extensions/action-owner'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import type { ExtensionView } from '../src/shared/extensions/workbench'

const root = join(__dirname, '..', 'extensions', 'gascity')
const manifest = JSON.parse(readFileSync(join(root, 'hvir-extension.json'), 'utf8')) as {
  views: { entry: string; navigationIcon?: string }[]
  actions: { id: string; agents: boolean }[]
  connectors: { id: string; actions?: string[] }[]
  actionConnectors: { id: string; actions?: string[] }[]
  optionalCapabilities: string[]
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
    expect(manifest.actions.find((item) => item.id === 'answer-decision')?.agents).toBe(
      false,
    )
  })

  it('declares hvir-answer as an action connector bound to the action, and validates on a core without the binding field', () => {
    expect(manifest.connectors.some((item) => item.id === 'hvir-answer')).toBe(false)
    expect(
      manifest.actionConnectors.find((item) => item.id === 'hvir-answer')?.actions,
    ).toEqual(['answer-decision'])
    expect(manifest.optionalCapabilities).toContain('connector.action-binding')
    const revision = gascityActivation().revision
    expect(revision.manifest.connectors?.some((item) => item.id === 'hvir-answer')).toBe(
      false,
    )
    for (const text of revision.warnings.filter((entry) =>
      entry.startsWith('Ignored unknown field'),
    ))
      expect(text).toMatch(/^Ignored unknown field: (actionConnectors|actions)$/)
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

async function handlerError(message: string): Promise<string> {
  const sent: { error?: string }[] = []
  const listeners = new Set<(message: unknown) => void>()
  const deliver = (message: unknown) => listeners.forEach((listener) => listener(message))
  const window: Record<string, unknown> = {
    host: {
      run: () => Promise.reject(new Error(message)),
    },
    hvirExtension: {
      onMessage: (listener: (message: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      send: (reply: { error?: string }) => sent.push(reply),
    },
  }
  runInNewContext(readFileSync(join(root, 'needs-model.js'), 'utf8'), { window })
  runInNewContext(readFileSync(join(root, 'answer.js'), 'utf8'), { window })
  ;(window['answerAction'] as { listen: (bridge: unknown) => void }).listen(
    window['hvirExtension'],
  )
  deliver({
    kind: 'hello',
    contract: '1.0',
    capabilities: ['connector.execute', 'connector.action-binding'],
  })
  deliver({
    kind: 'action',
    invocation: {
      id: 'inv-1',
      action: 'answer-decision',
      input: answer,
      context: { workspace: { id: 'ws-1', host: 'local' } },
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  return sent[0]!.error!
}

describe('Gas City answer-decision long errors through the real action owner', () => {
  const view: ExtensionView = {
    id: 'view',
    installationId: 'one',
    contributionId: 'projects',
    title: 'Gas City',
    extensionName: 'Gas City',
    partition: 'partition',
    url: 'hvir-extension://view/projects.html',
    context: { surface: 'viewer', visible: true },
  }

  async function invoked() {
    const ports = {
      open: vi.fn((_owner, _id, _view, _options, admit: () => void) => {
        admit()
        return Promise.resolve(view)
      }),
      dispatch: vi.fn(() => true),
      runnable: vi.fn(),
      cancelAction: vi.fn(),
      assertView: vi.fn(),
    } as unknown as ExtensionActionGuestPort
    const actions = new ExtensionActionOwner(ports)
    const result = actions.invoke(
      { id: 1, generation: 1 },
      gascityActivation(),
      'answer-decision',
      answer,
      { surface: 'viewer' },
      'human',
      'interactive',
      () => undefined,
    )
    const settled = result.then(
      () => 'resolved',
      (reason: Error) => reason.message,
    )
    await new Promise((resolve) => setImmediate(resolve))
    const invocation = vi.mocked(ports.dispatch).mock.calls[0]![1]
    return { actions, invocation, settled }
  }

  it('settles the invocation with the capped error the handler sends', async () => {
    const error = await handlerError('x'.repeat(900))
    expect(error.length).toBe(240)
    const { actions, invocation, settled } = await invoked()
    actions.result('view', invocation.id, undefined, error)
    expect(await settled).toBe(error)
  })

  it('refuses an uncapped 241 character error, which is why the handler caps it', async () => {
    const { actions, invocation } = await invoked()
    expect(() =>
      actions.result('view', invocation.id, undefined, 'x'.repeat(241)),
    ).toThrow('Invalid action error')
  })
})
