import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'

interface GatePackage {
  buildReadSurface(input: {
    bd?: { text: string; observedAt: number }
    bdReady?: { text: string; observedAt: number }
    bdGates?: { text: string; observedAt: number }
    bdGatesFailure?: { message: string; observedAt: number }
    gc?: { text: string; observedAt: number }
    gcRig?: { text: string; observedAt: number }
  }): {
    beads: { state: string }
    gates: {
      state: string
      gates: readonly {
        gate: {
          id: string
          title: string
          gateType: string
          blockedId?: string
          state: string
        }
        blocks?: { id: string; title: string }
      }[]
      message?: string
    }
  }
  gateElement(
    document: Document,
    item: {
      gate: {
        id: string
        title: string
        gateType: string
        blockedId?: string
      }
      blocks?: { id: string; title: string }
    },
  ): HTMLElement
  readWorkspace(
    client: {
      request(capability: string, input: unknown): Promise<unknown>
    },
    context: unknown,
    previous: unknown,
  ): Promise<unknown>
}

function packageApi(): GatePackage {
  const result = buildSync({
    stdin: {
      contents:
        "export * from './packages/beads-extension/src/model.mjs'; export * from './packages/beads-extension/src/render.mjs'; export * from './packages/beads-extension/src/bridge.mjs'",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'iife',
    globalName: 'GatePackage',
    write: false,
  })
  const context = { GatePackage: undefined as unknown, Date, Set, Map, URL }
  runInNewContext(result.outputFiles[0]!.text, context)
  return context.GatePackage as GatePackage
}

const api = packageApi()
const cityRigSource = {
  observedAt: 1,
  text: JSON.stringify({
    ok: true,
    city_path: '/city',
    rig: { name: 'city', path: '/city' },
  }),
}

describe('Beads workspace gates', () => {
  it('parses and renders open gates with the bead each gate unblocks', () => {
    const view = api.buildReadSurface({
      bd: {
        observedAt: 100,
        text: JSON.stringify([
          issue('blocked-1', 'task', 'blocked', { title: 'Ship release' }),
        ]),
      },
      bdReady: { observedAt: 100, text: '[]' },
      bdGates: {
        observedAt: 101,
        text: JSON.stringify([
          {
            id: 'gate-1',
            title: 'Approve release',
            gate_type: 'human',
            blocked_id: 'blocked-1',
            state: 'open',
          },
          {
            id: 'gate-2',
            title: 'Wait for CI',
            type: 'gh:run',
            issue_id: 'missing-1',
            status: 'open',
          },
        ]),
      },
      gc: { observedAt: 100, text: '{"ok":true,"sessions":[]}' },
      gcRig: cityRigSource,
    })
    expect(view.gates).toMatchObject({
      state: 'ready',
      gates: [
        {
          gate: {
            id: 'gate-1',
            title: 'Approve release',
            gateType: 'human',
            blockedId: 'blocked-1',
          },
          blocks: { id: 'blocked-1', title: 'Ship release' },
        },
        {
          gate: {
            id: 'gate-2',
            title: 'Wait for CI',
            gateType: 'gh:run',
            blockedId: 'missing-1',
          },
        },
      ],
    })
    const window = new Window()
    const first = api.gateElement(
      window.document as unknown as Document,
      view.gates.gates[0]!,
    )
    const second = api.gateElement(
      window.document as unknown as Document,
      view.gates.gates[1]!,
    )
    expect(first.textContent).toContain('human gate')
    expect(first.textContent).toContain('Approve release')
    expect(first.textContent).toContain('unblocks Ship release')
    expect(second.textContent).toContain('unblocks missing-1')
  })

  it('preserves every admitted gate identity and relationship', () =>
    hegel.test((tc) => {
      const id = tc.draw(gs.fromRegex('[A-Za-z0-9][A-Za-z0-9._:-]{0,80}'))
      const blockedId = tc.draw(gs.fromRegex('[A-Za-z0-9][A-Za-z0-9._:-]{0,80}'))
      const gateType = tc.draw(gs.fromRegex('[A-Za-z][A-Za-z0-9:-]{0,30}'))
      const view = api.buildReadSurface({
        bd: { observedAt: 1, text: '[]' },
        bdReady: { observedAt: 1, text: '[]' },
        bdGates: {
          observedAt: 1,
          text: JSON.stringify([
            {
              id,
              title: id,
              gate_type: gateType,
              blocked_id: blockedId,
              state: 'open',
            },
          ]),
        },
        gc: { observedAt: 1, text: '{"ok":true,"sessions":[]}' },
        gcRig: cityRigSource,
      })
      expect(view.gates.gates).toEqual([
        {
          gate: {
            id,
            title: id,
            gateType,
            blockedId,
            state: 'open',
          },
        },
      ])
    }))

  it('keeps gate failure and truncation separate from the bead snapshot', async () => {
    const client = {
      request(capability: string, input: unknown) {
        expect(capability).toBe('connector.execute')
        const request = input as { args: string[] }
        if (request.args[0] === 'gate')
          return Promise.resolve({ outcome: 'completed', code: 0, truncated: true })
        return Promise.resolve({ outcome: 'completed', code: 0, truncated: false })
      },
    }
    const input = (await api.readWorkspace(
      client,
      { workspace: { host: 'local', id: 'workspace-1' } },
      undefined,
    )) as Parameters<GatePackage['buildReadSurface']>[0]
    expect(input.bdGatesFailure).toMatchObject({
      message: 'bd output was truncated',
    })
    const view = api.buildReadSurface({
      ...input,
      bd: { text: '[]', observedAt: 1 },
      bdReady: { text: '[]', observedAt: 1 },
      gc: { text: '{"ok":true,"sessions":[]}', observedAt: 1 },
      gcRig: cityRigSource,
    })
    expect(view.beads.state).toBe('empty')
    expect(view.gates).toMatchObject({
      state: 'error',
      message: 'bd output was truncated',
    })
  })

  it('distinguishes malformed gate output from successful emptiness', () => {
    const malformed = api.buildReadSurface({
      bd: { text: '[]', observedAt: 3 },
      bdReady: { text: '[]', observedAt: 3 },
      bdGates: { text: '{', observedAt: 3 },
      gc: { text: '{"ok":true,"sessions":[]}', observedAt: 3 },
      gcRig: cityRigSource,
    })
    expect(malformed.gates).toMatchObject({
      state: 'error',
      message: 'Invalid structured bd gate output',
    })
  })
})

function issue(
  id: string,
  issueType: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: id,
    issue_type: issueType,
    status,
    priority: 2,
    labels: [],
    dependency_count: 0,
    dependent_count: 0,
    ...extra,
  }
}
