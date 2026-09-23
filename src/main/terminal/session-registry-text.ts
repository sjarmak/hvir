const MAX_TERMINAL_TITLE_LENGTH = 240

export function cleanTerminalTitle(value: string): string {
  const title = [...value]
    .map((character) => (hasTerminalControlCharacter(character) ? ' ' : character))
    .join('')
    .trim()
  return title.slice(0, MAX_TERMINAL_TITLE_LENGTH) || 'Terminal'
}

export function isHarnessSessionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    !/\s/.test(value) &&
    !hasTerminalControlCharacter(value)
  )
}

export function hasTerminalControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}
