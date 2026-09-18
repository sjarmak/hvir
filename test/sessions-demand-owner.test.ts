import { describe, expect, it } from 'vitest'

import {
  demandOwnerKey,
  dispatchDemandOwner,
  rendererDemandOwner,
  requireRendererOwner,
  sameDemandOwner,
  type SessionsDemandOwner,
} from '../src/main/sessions/sessions-demand-owner'

describe('SessionsDemandOwner', () => {
  it('wraps a renderer owner as the renderer kind and unwraps it exactly', () => {
    const owner = rendererDemandOwner({ id: 9, generation: 2 })
    expect(owner).toEqual({ kind: 'renderer', id: 9, generation: 2 })
    expect(requireRendererOwner(owner, 'open')).toEqual({ id: 9, generation: 2 })
  })

  it('never collides keys across kinds for equal numbers', () => {
    const renderer: SessionsDemandOwner = { kind: 'renderer', id: 1, generation: 1 }
    const companion: SessionsDemandOwner = { kind: 'companion', page: '1', generation: 1 }
    expect(demandOwnerKey(renderer)).toBe('renderer:1:1')
    expect(demandOwnerKey(companion)).toBe('companion:1:1')
    expect(demandOwnerKey(renderer)).not.toBe(demandOwnerKey(companion))
    expect(sameDemandOwner(renderer, companion)).toBe(false)
    expect(sameDemandOwner(renderer, { kind: 'renderer', id: 1, generation: 1 })).toBe(
      true,
    )
    expect(sameDemandOwner(renderer, { kind: 'renderer', id: 1, generation: 2 })).toBe(
      false,
    )
    expect(
      sameDemandOwner(companion, { kind: 'companion', page: '1', generation: 1 }),
    ).toBe(true)
  })

  it('dispatches by kind and refuses a companion owner at a renderer verb', () => {
    const companion: SessionsDemandOwner = {
      kind: 'companion',
      page: 'p-1',
      generation: 3,
    }
    expect(
      dispatchDemandOwner(companion, {
        renderer: () => 'renderer',
        companion: (owner) => `companion:${owner.page}`,
      }),
    ).toBe('companion:p-1')
    expect(
      dispatchDemandOwner(rendererDemandOwner({ id: 4, generation: 1 }), {
        renderer: (owner) => `renderer:${owner.id}`,
        companion: () => 'companion',
      }),
    ).toBe('renderer:4')
    expect(() => requireRendererOwner(companion, 'open')).toThrow(
      'Sessions open is a renderer verb',
    )
  })
})
