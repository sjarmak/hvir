export const BEAD_COMMAND_EVENT = 'hvir:bead-command'
export interface BeadCommandDetail {
  readonly command: string
  readonly root: import('../../../shared').HostPath
  readonly resolve: (accepted: boolean) => void
}
export function dispatchBeadCommand(
  root: BeadCommandDetail['root'],
  command: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let claimed = false
    window.dispatchEvent(new CustomEvent<BeadCommandDetail>(BEAD_COMMAND_EVENT, {
      detail: { root, command, resolve: (accepted) => { claimed = true; resolve(accepted) } },
    }))
    if (!claimed) resolve(false)
  })
}
