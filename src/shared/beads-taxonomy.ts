/**
 * The single source of truth for "what kind of bead is this" and "is it human
 * executable work." Both the main process (structural dispatchable fallback)
 * and the renderer (section classification) import from here, so the policy is
 * defined exactly once — never duplicated across UI components or re-derived
 * from title/description/notes keywords.
 */

/**
 * How a bead reads to a human, derived purely from its typed `issue_type`.
 *
 * - `executable-leaf` — real leaf work a person or agent runs: feature/bug/task/chore.
 * - `outcome` — an accepted goal/grouping, not a job: epic (and decision, which is
 *   a human choice surfaced via status/gate, not an executable step).
 * - `orchestration` — workflow scaffolding: convoy, molecule (workflow roots,
 *   formula steps). Hidden from human counts, collapsed under its source work.
 * - `gate` — an async coordination gate; the human-actionable ones drive "Needs you".
 * - `ship` — merge-request: branch/review/deploy-ready work, never "Ready next".
 * - `infra` — agent/rig/role/message beads: pure machinery, hidden by default.
 * - `unknown` — a type we do not recognise; surfaced as a data-hygiene issue rather
 *   than silently treated as executable.
 */
export type BeadCategory =
  | 'executable-leaf'
  | 'outcome'
  | 'orchestration'
  | 'gate'
  | 'ship'
  | 'infra'
  | 'unknown'

/**
 * `bd`'s issue-type aliases (see `bd list -t` help): mr→merge-request,
 * feat→feature, mol→molecule, dec/adr→decision. Normalise before classifying so
 * an alias never falls through to `unknown`.
 */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  mr: 'merge-request',
  feat: 'feature',
  mol: 'molecule',
  dec: 'decision',
  adr: 'decision',
}

const CATEGORY_BY_TYPE: Readonly<Record<string, BeadCategory>> = {
  feature: 'executable-leaf',
  bug: 'executable-leaf',
  task: 'executable-leaf',
  chore: 'executable-leaf',
  epic: 'outcome',
  decision: 'outcome',
  convoy: 'orchestration',
  molecule: 'orchestration',
  gate: 'gate',
  'merge-request': 'ship',
  agent: 'infra',
  rig: 'infra',
  role: 'infra',
  message: 'infra',
}

/** Normalise casing + aliases so classification is stable across bd spellings. */
function normalizeType(issueType: string): string {
  const lower = issueType.trim().toLowerCase()
  return TYPE_ALIASES[lower] ?? lower
}

/** Map a raw `bd` issue type to its human category. Unknown types stay visible. */
export function classifyIssueType(issueType: string): BeadCategory {
  return CATEGORY_BY_TYPE[normalizeType(issueType)] ?? 'unknown'
}

/**
 * Is this real, human-executable leaf work? The predicate the "Ready next" queue
 * and the structural dispatchable fallback both gate on. Outcomes, orchestration,
 * gates, ship work, infra, and unknown types are all excluded — so they can never
 * inflate executable-work counts.
 */
export function isExecutableLeaf(issueType: string): boolean {
  return classifyIssueType(issueType) === 'executable-leaf'
}
