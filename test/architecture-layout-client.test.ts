import { afterEach, expect, it, vi } from 'vitest'

class LayoutWorker {
  static instance: LayoutWorker
  static instances: LayoutWorker[] = []
  readonly messages: unknown[] = []
  terminated = false
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null

  constructor() {
    LayoutWorker.instance = this
    LayoutWorker.instances.push(this)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }
}

afterEach(() => {
  LayoutWorker.instances = []
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('uses the ELK worker protocol and maps the returned graph', async () => {
  vi.stubGlobal('Worker', LayoutWorker)
  const { requestArchitectureLayout } = await import(
    '../src/renderer/src/architecture-review/architecture-layout-client'
  )
  const result = requestArchitectureLayout({
    nodes: [{ id: 'node', width: 100, height: 60 }],
    edges: [],
  })

  expect(LayoutWorker.instance.messages).toEqual([
    { cmd: 'register', id: 0, algorithms: ['layered'] },
    expect.objectContaining({ cmd: 'layout', id: 1 }),
  ])
  LayoutWorker.instance.onmessage?.(
    new MessageEvent('message', {
      data: {
        id: 1,
        data: {
          id: 'architecture',
          children: [{ id: 'node', x: 7, y: 9 }],
          edges: [
            {
              id: 'edge',
              sources: ['a'],
              targets: ['b'],
              sections: [
                {
                  id: 'edge_s0',
                  startPoint: { x: 1, y: 2 },
                  bendPoints: [{ x: 3, y: 4 }],
                  endPoint: { x: 5, y: 6 },
                },
              ],
            },
          ],
        },
      },
    }),
  )

  await expect(result).resolves.toEqual({
    positions: [{ id: 'node', x: 7, y: 9 }],
    edges: [
      {
        id: 'edge',
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
        ],
      },
    ],
  })
})

it('surfaces the underlying worker failure', async () => {
  vi.stubGlobal('Worker', LayoutWorker)
  const { requestArchitectureLayout } = await import(
    '../src/renderer/src/architecture-review/architecture-layout-client'
  )
  const result = requestArchitectureLayout({ nodes: [], edges: [] })

  LayoutWorker.instance.onerror?.({
    type: 'error',
    message: '_Worker is not a constructor',
  } as ErrorEvent)

  await expect(result).rejects.toThrow(
    'Architecture layout worker failed: _Worker is not a constructor',
  )
})

it('surfaces an ELK registration failure to pending layouts', async () => {
  vi.stubGlobal('Worker', LayoutWorker)
  const { requestArchitectureLayout } = await import(
    '../src/renderer/src/architecture-review/architecture-layout-client'
  )
  const result = requestArchitectureLayout({ nodes: [], edges: [] })

  LayoutWorker.instance.onmessage?.(
    new MessageEvent('message', {
      data: { id: 0, error: 'Unknown algorithm: layered' },
    }),
  )

  await expect(result).rejects.toThrow(
    'Architecture layout worker registration failed: Unknown algorithm: layered',
  )
  expect(LayoutWorker.instance.terminated).toBe(true)
})

it('terminates the worker and rejects pending layouts when its module is replaced', async () => {
  vi.stubGlobal('Worker', LayoutWorker)
  const { disposeArchitectureLayoutWorker, requestArchitectureLayout } = await import(
    '../src/renderer/src/architecture-review/architecture-layout-client'
  )
  const result = requestArchitectureLayout({ nodes: [], edges: [] })
  const first = LayoutWorker.instance

  disposeArchitectureLayoutWorker()

  expect(first.terminated).toBe(true)
  await expect(result).rejects.toThrow('Architecture layout worker replaced')
  void requestArchitectureLayout({ nodes: [], edges: [] })
  expect(LayoutWorker.instances).toHaveLength(2)
})
