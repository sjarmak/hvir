// @vitest-environment happy-dom
import { readExtensionPackageManifest } from './fixtures/extension-package-files'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionViewLauncher } from '../src/renderer/src/settings/sections/ExtensionViewLauncher'
import { ExtensionTargetedViewLauncher } from '../src/renderer/src/extensions/ExtensionTargetedViewLauncher'
import { ExtensionContributionContext } from '../src/renderer/src/extensions/extension-contribution-context'
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
function fixture(path: string) {
  const manifest = readExtensionPackageManifest(path)
  const invoke = vi.fn().mockResolvedValue({})
  vi.stubGlobal('hvir', { invoke })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      createElement(ExtensionViewLauncher, {
        installation: {
          installationId: 'installed',
          manifest,
          enabled: true,
          source: 'fixture',
          warnings: [],
        },
        disabled: false,
        onRun: async (work) => {
          await work()
        },
      }),
    ),
  )
  return { host, invoke }
}
it.each([
  [
    'packages/extension-reference/hvir-extension.json',
    'reference',
    'Extension reference',
  ],
  ['packages/extension-authoring/clock/hvir-extension.json', 'clock', 'Clock'],
])(
  'keeps a compact explicit manual route without declaring automatic landing: %s',
  async (manifest, id, title) => {
    const f = fixture(manifest)
    expect(f.invoke).not.toHaveBeenCalled()
    const button = f.host.querySelector('button')!
    expect(button.textContent).toBe(`Open ${title}`)
    expect(f.host.querySelectorAll('button')).toHaveLength(1)
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(f.invoke).toHaveBeenCalledWith('extensions:open-view', {
      installationId: 'installed',
      contributionId: id,
    })
  },
)
it('uses the declared landing without exposing input-dependent secondary or duplicate task routes', async () => {
  const f = fixture('packages/skillager-extension/hvir-extension.json')
  expect(f.host.querySelector('select')).toBeNull()
  expect(f.host.querySelectorAll('button')).toHaveLength(1)
  expect(f.host.querySelector('button')?.textContent).toBe('Open Skillager library')
  await act(async () => {
    f.host.querySelector('button')!.click()
    await Promise.resolve()
  })
  expect(f.invoke).toHaveBeenCalledWith('extensions:open-view', {
    installationId: 'installed',
    contributionId: 'library',
  })
})

it('resolves one installed workspace contribution and names its revision in targeted input', async () => {
  const invoke = vi.fn().mockResolvedValue({ id: 'view' })
  vi.stubGlobal('hvir', { invoke })
  const opened = vi.fn()
  const unavailable = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      createElement(
        ExtensionContributionContext.Provider,
        {
          value: {
            state: [
              {
                installationId: 'installed',
                revision: 'revision-1',
                extensionName: 'Beads',
                manifest: {
                  id: 'beads-extension',
                  name: 'Beads',
                  version: '1.0.0',
                  contract: '1.0',
                  requiredCapabilities: [],
                  optionalCapabilities: [],
                  access: [],
                  views: [
                    {
                      id: 'beads',
                      title: 'Beads',
                      entry: 'index.html',
                      placement: 'workspace',
                      navigation: 'left',
                      representations: ['view'],
                    },
                  ],
                },
                values: [],
              },
            ],
            stateReady: true,
            targetedInput: (request: {
              readonly installationId: string
              readonly revision: string
              readonly contributionId: string
              readonly workspaceId: string
              readonly input: unknown
            }) =>
              window.hvir.invoke('extensions:target-view-input', request),
          } as never,
        },
        createElement(ExtensionTargetedViewLauncher, {
          target: {
            requestId: 'hvir-1',
            contributionId: 'beads',
            workspaceId: 'workspace',
            input: { focusBeadId: 'hvir-1' },
          },
          onOpened: opened,
          onUnavailable: unavailable,
        }),
      ),
    )
    await Promise.resolve()
  })
  expect(invoke).toHaveBeenCalledWith('extensions:target-view-input', {
    installationId: 'installed',
    revision: 'revision-1',
    contributionId: 'beads',
    workspaceId: 'workspace',
    input: { focusBeadId: 'hvir-1' },
  })
  expect(opened).toHaveBeenCalledWith('hvir-1', { id: 'view' })
  expect(unavailable).not.toHaveBeenCalled()
})

it('reports unavailable targeted input without consuming the Needs you row', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const unavailable = vi.fn()
  await act(async () => {
    root!.render(
      createElement(
        ExtensionContributionContext.Provider,
        { value: { state: [], stateReady: true, targetedInput: vi.fn() } as never },
        createElement(ExtensionTargetedViewLauncher, {
          target: {
            requestId: 'hvir-1',
            contributionId: 'beads',
            workspaceId: 'workspace',
            input: { focusBeadId: 'hvir-1' },
          },
          onOpened: vi.fn(),
          onUnavailable: unavailable,
        }),
      ),
    )
    await Promise.resolve()
  })
  expect(unavailable).toHaveBeenCalledWith('hvir-1')
})
