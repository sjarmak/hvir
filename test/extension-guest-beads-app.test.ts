import { readFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'

function fixture() {
  const window = new Window()
  const template = window.document.createElement('template')
  template.innerHTML = readFileSync('packages/beads-extension/index.html', 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  window.document.body.replaceChildren(template.content.cloneNode(true))
  const subscribers = new Set<(message: unknown) => void>()
  let actionResult: unknown = { outcome: 'handed-off', terminalId: 'terminal-1' }
  const emit = (message: unknown) => {
    for (const subscriber of subscribers) subscriber(message)
  }
  const bridge = {
    onMessage(callback: (message: unknown) => void) {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    send(message: Record<string, unknown>) {
      if (message['kind'] !== 'request') return
      emit({
        kind: 'result',
        id: message['id'],
        ok: true,
        value: actionResult,
      })
    },
  }
  Object.assign(window, { hvirExtension: bridge })
  const bundle = buildSync({
    entryPoints: ['packages/beads-extension/src/app.mjs'],
    bundle: true,
    format: 'iife',
    write: false,
  })
  runInNewContext(bundle.outputFiles[0]!.text, {
    window,
    document: window.document,
    Date,
    performance,
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
  })
  return {
    document: window.document,
    show() {
      emit({ kind: 'context', context: { visible: true } })
    },
    action(value: unknown) {
      actionResult = value
    },
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('Beads package app outcomes', () => {
  it('keeps a create title and surfaces the reason when terminal launch does not start', async () => {
    const app = fixture()
    app.action({ outcome: 'not-started', reason: 'Terminal launch was declined' })
    app.show()
    await settle()
    const form = app.document.getElementById('create') as unknown as HTMLFormElement
    const title = app.document.getElementById(
      'create-title',
    ) as unknown as HTMLInputElement
    title.value = 'Keep this bead'
    form.dispatchEvent(
      new app.document.defaultView!.Event('submit', {
        cancelable: true,
      }) as unknown as Event,
    )
    await settle()
    expect(title.value).toBe('Keep this bead')
    expect(app.document.getElementById('state')?.textContent).toBe(
      'Terminal launch was declined',
    )
  })

  it('surfaces refresh publication errors in the package view', async () => {
    const app = fixture()
    const sections = app.document.getElementById('sections')!
    sections.replaceChildren = () => {
      throw new Error('Beads render failed')
    }
    app.show()
    await settle()
    expect(app.document.getElementById('state')).toMatchObject({
      textContent: 'Beads render failed',
      dataset: { state: 'error' },
    })
  })
})
