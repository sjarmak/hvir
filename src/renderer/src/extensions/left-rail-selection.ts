import type { ExtensionView } from '../../../shared/extensions/workbench'

export interface LeftRailChoice {
  readonly installationId: string
  readonly contributionId: string
}

export type LeftRailChoices = ReadonlyMap<string, LeftRailChoice>

export const RETAINED_LEFT_WORKSPACES = 4

export function withChoice(
  choices: LeftRailChoices,
  workspaceId: string,
  choice: LeftRailChoice | undefined,
): LeftRailChoices {
  const next = new Map(choices)
  if (choice) next.set(workspaceId, choice)
  else next.delete(workspaceId)
  return next
}

export function sameChoice(
  left: LeftRailChoice | undefined,
  right: LeftRailChoice | undefined,
): boolean {
  return (
    left?.installationId === right?.installationId &&
    left?.contributionId === right?.contributionId
  )
}

export function leftViewFor(
  views: readonly ExtensionView[],
  workspaceId: string | undefined,
  choice: LeftRailChoice | undefined,
): ExtensionView | undefined {
  if (!workspaceId || !choice) return undefined
  return views.find(
    (view) =>
      view.role !== 'updater' &&
      view.context?.surface === 'left' &&
      view.context.workspace?.id === workspaceId &&
      sameChoice(view, choice),
  )
}

export function touchWorkspace(
  recent: readonly string[],
  workspaceId: string,
  limit = RETAINED_LEFT_WORKSPACES,
): readonly string[] {
  return [workspaceId, ...recent.filter((id) => id !== workspaceId)].slice(0, limit)
}

export function evictedLeftViews(
  views: readonly ExtensionView[],
  retained: readonly string[],
): readonly ExtensionView[] {
  return views.filter(
    (view) =>
      view.context?.surface === 'left' &&
      !retained.includes(view.context.workspace?.id ?? ''),
  )
}
