/**
 * The gc attach command, composed in one place.
 *
 * Both halves of hvir need it: the crew view builds it from a member it is
 * already showing, and main builds it for a projected Sessions row, whose
 * session identifier the renderer is not allowed to hold (ADR-046). The text
 * itself is gc's public alias, the same string a person would type.
 */

export interface GasCityAttachCommand {
  readonly command: string
  /** Identity for focus-or-launch: a repeat attach focuses the terminal. */
  readonly key: string
}

export function gasCityAttachCommand(target: string): GasCityAttachCommand {
  return {
    command: `gc session attach ${shellQuoteArg(target)}`,
    key: `gc:${target}`,
  }
}

/**
 * POSIX single-quote a value so it is safe to splice into an interactive shell
 * command line. Session names are normally plain identifiers, but the value
 * flows into a shell, so quote defensively rather than trusting the input.
 */
export function shellQuoteArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
