import type { RendererOwner } from '../renderer-resource-scopes'

export interface FocusableWindow {
  isFocused(): boolean
  on(event: 'focus', listener: () => void): unknown
  on(event: 'blur', listener: () => void): unknown
}

export function bindRendererFocus(
  win: FocusableWindow,
  currentOwner: () => RendererOwner,
  setOwnerFocused: (owner: RendererOwner, focused: boolean) => void,
): () => void {
  const seed = (): void => setOwnerFocused(currentOwner(), win.isFocused())
  seed()
  win.on('focus', () => setOwnerFocused(currentOwner(), true))
  win.on('blur', () => setOwnerFocused(currentOwner(), false))
  return seed
}
