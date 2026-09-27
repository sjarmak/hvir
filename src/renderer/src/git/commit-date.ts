const RECORDED_DATE = /^(\d{4}-\d{2}-\d{2})T/

export function commitDate(authoredAt: string): string {
  const recorded = RECORDED_DATE.exec(authoredAt)
  if (recorded) return recorded[1]!
  const time = Date.parse(authoredAt)
  if (Number.isNaN(time)) return authoredAt
  const local = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
}
