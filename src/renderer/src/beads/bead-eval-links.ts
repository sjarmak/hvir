const MAX_URL_LENGTH = 2048
const MAX_FACT_LENGTH = 256
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const RECORDED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

interface EvalFact {
  readonly label: string
  readonly value: string
}

export type BeadEvalLink =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'available'
      readonly url: string
      readonly origin: string
      readonly facts: readonly EvalFact[]
      readonly invalidFields: readonly string[]
    }

const FIELDS = [
  ['eval.run_id', 'Run ID'],
  ['eval.candidate_sha', 'Candidate commit'],
  ['eval.baseline_sha', 'Baseline commit'],
  ['eval.model', 'Model'],
  ['eval.config', 'Config'],
  ['eval.recorded_at', 'Recorded at'],
] as const

export function beadEvalLink(
  metadata: Readonly<Record<string, string>> | undefined,
): BeadEvalLink {
  if (
    !metadata ||
    !['eval.run_url', ...FIELDS.map(([key]) => key)].some((key) =>
      Object.hasOwn(metadata, key),
    )
  )
    return { kind: 'absent' }
  const url = metadata['eval.run_url']
  const origin = evalUrlOrigin(url)
  if (!url || !origin) return { kind: 'invalid' }
  const fields = FIELDS.map(([key, label]) => ({
    key,
    label,
    value: metadata[key],
  })).filter(
    (field): field is typeof field & { value: string } => field.value !== undefined,
  )
  return {
    kind: 'available',
    url,
    origin,
    facts: fields
      .filter(({ key, value }) => validFact(key, value))
      .map(({ label, value }) => ({ label, value })),
    invalidFields: fields
      .filter(({ key, value }) => !validFact(key, value))
      .map(({ label }) => label),
  }
}

function evalUrlOrigin(raw: string | undefined): string | undefined {
  if (
    !raw ||
    raw.length > MAX_URL_LENGTH ||
    raw.trim() !== raw ||
    UNSAFE_TEXT.test(raw) ||
    raw.includes('\\')
  )
    return undefined
  try {
    if (UNSAFE_TEXT.test(decodeURIComponent(raw))) return undefined
    const url = new URL(raw)
    if (
      url.protocol !== 'https:' ||
      !raw.startsWith('https://') ||
      url.username ||
      url.password ||
      !url.hostname
    )
      return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function validFact(key: string, value: string): boolean {
  if (!value.trim() || value.length > MAX_FACT_LENGTH || UNSAFE_TEXT.test(value))
    return false
  if (key.endsWith('_sha')) return COMMIT_ID.test(value)
  if (key === 'eval.recorded_at') {
    if (!RECORDED_AT.test(value) || !Number.isFinite(Date.parse(value))) return false
    return new Date(value).toISOString() === value.replace(/(?<=:\d{2})Z$/, '.000Z')
  }
  return true
}
