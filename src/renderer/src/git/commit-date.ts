export function commitDate(authoredAt: string): string {
  const time = Date.parse(authoredAt)
  if (Number.isNaN(time)) return authoredAt
  return new Date(time).toISOString().slice(0, 10)
}
