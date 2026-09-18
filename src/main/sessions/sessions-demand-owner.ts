import type { RendererOwner } from '../renderer-resource-scopes'

/**
 * Who holds a Sessions demand lease.
 *
 * A renderer owner is a live webContents generation, and its changes travel
 * over IPC. A companion owner is a served page (ADR-049) with its own
 * generation, and its changes travel to the registered companion sink. The
 * discriminant keeps the two apart at the type level, so a companion never
 * borrows a renderer id and every port dispatches by kind rather than by a
 * sentinel value.
 */
export type SessionsDemandOwner =
  | { readonly kind: 'renderer'; readonly id: number; readonly generation: number }
  | { readonly kind: 'companion'; readonly page: string; readonly generation: number }

export type SessionsRendererDemandOwner = Extract<
  SessionsDemandOwner,
  { kind: 'renderer' }
>
export type SessionsCompanionDemandOwner = Extract<
  SessionsDemandOwner,
  { kind: 'companion' }
>

/** The verbs only a renderer may perform through the Sessions ports. */
export type SessionsRendererVerb = 'open' | 'attach'

export interface SessionsDemandOwnerRoutes<T> {
  readonly renderer: (owner: SessionsRendererDemandOwner) => T
  readonly companion: (owner: SessionsCompanionDemandOwner) => T
}

export function rendererDemandOwner(owner: RendererOwner): SessionsRendererDemandOwner {
  return { kind: 'renderer', id: owner.id, generation: owner.generation }
}

/** The renderer owner a renderer-kind lease stands for, without the discriminant. */
export function rendererOwnerOf(owner: SessionsRendererDemandOwner): RendererOwner {
  return { id: owner.id, generation: owner.generation }
}

/** A lease key that never collides across kinds, whatever the numbers. */
export function demandOwnerKey(owner: SessionsDemandOwner): string {
  return dispatchDemandOwner(owner, {
    renderer: (renderer) => `renderer:${renderer.id}:${renderer.generation}`,
    companion: (companion) => `companion:${companion.page}:${companion.generation}`,
  })
}

export function sameDemandOwner(a: SessionsDemandOwner, b: SessionsDemandOwner): boolean {
  return demandOwnerKey(a) === demandOwnerKey(b)
}

/** Exhaustive dispatch by kind; an unknown kind is a programming error. */
export function dispatchDemandOwner<T>(
  owner: SessionsDemandOwner,
  routes: SessionsDemandOwnerRoutes<T>,
): T {
  switch (owner.kind) {
    case 'renderer':
      return routes.renderer(owner)
    case 'companion':
      return routes.companion(owner)
    default:
      return unknownDemandOwner(owner)
  }
}

/**
 * Narrows to the renderer owner a renderer-only verb needs. A companion owner
 * reaching such a verb is a caller bug, and it throws rather than resolving.
 */
export function requireRendererOwner(
  owner: SessionsDemandOwner,
  verb: SessionsRendererVerb,
): RendererOwner {
  return dispatchDemandOwner(owner, {
    renderer: rendererOwnerOf,
    companion: () => {
      throw new Error(`Sessions ${verb} is a renderer verb`)
    },
  })
}

function unknownDemandOwner(owner: never): never {
  throw new Error(`Unknown Sessions demand owner: ${JSON.stringify(owner)}`)
}
