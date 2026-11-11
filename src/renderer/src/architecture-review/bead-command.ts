import { shellQuoteArg } from '../../../shared'

const TERMINAL_CONTROL = /[\p{Cc}\u2028\u2029]/u

export function createBeadCommand(
  title: string,
  description: string,
): string | undefined {
  if (TERMINAL_CONTROL.test(title) || TERMINAL_CONTROL.test(description)) return undefined
  return `bd create --title ${shellQuoteArg(title)} --description ${shellQuoteArg(description)}`
}
