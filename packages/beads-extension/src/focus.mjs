const beadId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

export function focusBeadId(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input.focusBeadId
  return typeof value === 'string' && beadId.test(value) ? value : undefined
}

export function focusResult(input, surface) {
  const id = focusBeadId(input)
  if (!id) return { state: 'none' }
  if (!['ready', 'empty'].includes(surface?.beads?.state))
    return { state: 'pending', id }
  const issues = Array.isArray(surface?.beads?.issues) ? surface.beads.issues : []
  return issues.some((issue) => issue?.id === id)
    ? { state: 'found', id }
    : { state: 'missing', id }
}
