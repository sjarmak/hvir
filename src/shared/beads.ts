/**
 * The bd issue-id grammar, as observed in live stores: `<prefix>-<base36>`
 * (`projects-5c6`), hierarchical children (`projects-sl7.4`), and uuid wisps.
 * One ASCII token — letters, digits, `.`, `_`, `:`, `-` — so an id can never
 * carry a shell metacharacter, whitespace, or a byte a PTY line editor would
 * read as a key. Matches the work-id grammar gas-city's exporter enforces.
 */
export const BEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export function isBeadId(value: string): boolean {
  return BEAD_ID_PATTERN.test(value)
}
