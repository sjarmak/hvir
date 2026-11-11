import { beadNeedsHuman, isAnsweredAsk } from '../../../src/shared/beads-human.ts'
import { classifyIssueType } from '../../../src/shared/beads-taxonomy.ts'

const sectionOrder = [
  ['needs-you', 'Needs you'],
  ['answered', 'Answered by you'],
  ['in-flight', 'In flight'],
  ['ready-to-ship', 'Ready to ship'],
  ['dependency-ready', 'Dependency-ready / needs classification'],
  ['planned', 'Planned'],
  ['blocked', 'Blocked'],
  ['data-hygiene', 'Data hygiene'],
]

export function buildReadSurface(input) {
  const previous = input.previous
  return {
    beads: sourceView(
      input.bd,
      input.bdFailure,
      previous?.beads,
      parseBeads,
      'structured bd output',
    ),
    crew: sourceView(
      input.gc,
      input.gcFailure,
      previous?.crew,
      (text, observedAt) => parseCrew(text, observedAt, input.bd, previous?.beads),
      'structured gc output',
    ),
  }
}

function sourceView(source, failure, previous, parse, label) {
  if (failure)
    return {
      ...(previous ?? emptySource()),
      state: 'error',
      message: failure.message,
      observedAt: failure.observedAt,
    }
  if (!source)
    return {
      ...(previous ?? emptySource()),
      state: 'unavailable',
      message: `${label} is unavailable`,
    }
  try {
    return parse(source.text, source.observedAt)
  } catch {
    return {
      ...(previous ?? emptySource()),
      state: 'error',
      message: `Invalid ${label}`,
      observedAt: source.observedAt,
    }
  }
}

function emptySource() {
  return { sections: [], groups: [] }
}

export function parseBeads(text, observedAt) {
  const raw = JSON.parse(text)
  if (!Array.isArray(raw)) throw new Error('Invalid structured bd output')
  const issues = raw.map(readIssue)
  const buckets = new Map(sectionOrder.map(([key]) => [key, []]))
  const ready = new Set(
    issues
      .filter(
        (issue) =>
          issue.status === 'open' &&
          issue.dependencyCount === 0 &&
          classifyIssueType(issue.issueType) === 'executable-leaf',
      )
      .map((issue) => issue.id),
  )
  for (const issue of issues) {
    const category = classifyIssueType(issue.issueType)
    if (['orchestration', 'infra', 'gate'].includes(category)) continue
    let key
    if (category === 'unknown') key = 'data-hygiene'
    else if (beadNeedsHuman(issue)) key = 'needs-you'
    else if (isAnsweredAsk(issue)) key = 'answered'
    else if (issue.status === 'in_progress') key = 'in-flight'
    else if (issue.status === 'blocked' || issue.dependencyCount > 0) key = 'blocked'
    else if (shipState(issue, category)) key = 'ready-to-ship'
    else if (ready.has(issue.id)) key = 'dependency-ready'
    else key = 'planned'
    buckets.get(key).push(issue)
  }
  const sections = sectionOrder.map(([key, label]) => ({
    key,
    label,
    items: buckets.get(key).sort(compareIssues),
    count: buckets.get(key).length,
  }))
  return {
    state: issues.length ? 'ready' : 'empty',
    observedAt,
    sections,
    issues,
  }
}

function readIssue(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid issue')
  const id = string(value.id)
  const title = string(value.title)
  const issueType = string(value.issue_type ?? value.issueType)
  const status = string(value.status)
  const labels = Array.isArray(value.labels) ? value.labels.map(string) : []
  const metadata = readMetadata(value.metadata)
  return {
    id,
    title,
    issueType,
    status,
    labels,
    metadata,
    priority: integer(value.priority, 4),
    dependencyCount: integer(value.dependency_count ?? value.dependencyCount, 0),
    dependentCount: integer(value.dependent_count ?? value.dependentCount, 0),
    ...(optionalString(value.assignee) ? { assignee: value.assignee } : {}),
    ...(optionalString(value.parent) ? { parent: value.parent } : {}),
    ...(optionalString(value.updated_at ?? value.updatedAt)
      ? { updatedAt: value.updated_at ?? value.updatedAt }
      : {}),
  }
}

function readMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry) => typeof entry[0] === 'string' && typeof entry[1] === 'string',
    ),
  )
}

function shipState(issue, category) {
  return (
    category === 'ship' ||
    Boolean(issue.metadata['gc.outcome'] || issue.metadata['gc.pr'])
  )
}

function compareIssues(left, right) {
  return left.priority - right.priority || left.id.localeCompare(right.id)
}

export function parseCrew(text, observedAt, bdSource, previousBeads) {
  const raw = JSON.parse(text)
  if (!raw || raw.ok !== true || !Array.isArray(raw.sessions))
    throw new Error('Invalid structured gc output')
  let issues = previousBeads?.issues ?? []
  if (bdSource) {
    try {
      issues = parseBeads(bdSource.text, bdSource.observedAt).issues
    } catch {
      issues = previousBeads?.issues ?? []
    }
  }
  const members = raw.sessions.map((session) => crewMember(session, issues))
  const groups = [
    {
      key: 'leads',
      label: 'Leads',
      members: members.filter((member) => member.tier === 'lead'),
    },
    {
      key: 'workers',
      label: 'Workers',
      members: members.filter((member) => member.tier === 'worker'),
    },
    {
      key: 'internals',
      label: 'Internals',
      members: members.filter((member) => member.tier === 'internal'),
    },
  ]
  return { state: members.length ? 'ready' : 'empty', observedAt, groups }
}

function crewMember(value, issues) {
  if (!value || typeof value !== 'object') throw new Error('Invalid crew member')
  const id = string(value.id)
  const name = string(value.name)
  const alias = optionalString(value.alias)
  const template = optionalString(value.template)
  const identities = new Set([id, name, alias, template].filter(Boolean))
  if (template) identities.add(template.split('/').filter(Boolean).at(-1))
  const owned = issues.filter(
    (issue) =>
      issue.status !== 'closed' && issue.assignee && identities.has(issue.assignee),
  )
  const projected = optionalString(value.active_bead ?? value.activeBead)
  const active = projected
    ? (issues.find((issue) => issue.id === projected) ?? {
        id: projected,
        title: projected,
      })
    : owned.find((issue) => issue.status === 'in_progress')
  const tier = crewTier(name, alias, template)
  return {
    id,
    label: alias ?? name,
    state: string(value.state),
    tier,
    ...(active ? { bead: { id: active.id, title: active.title } } : {}),
    held: owned
      .filter((issue) => issue.id !== active?.id)
      .sort(compareIssues)
      .map((issue) => ({ id: issue.id, title: issue.title })),
  }
}

function crewTier(name, alias, template) {
  if (bindingIdentity([name, alias, template])) return 'internal'
  if (alias?.includes('/')) return 'internal'
  if (alias) return 'lead'
  if (template?.includes('/')) return 'worker'
  return 'internal'
}

function bindingIdentity(identities) {
  return identities.some((identity) =>
    identity?.split('/').filter(Boolean).at(-1)?.includes('.'),
  )
}

function string(value) {
  if (typeof value !== 'string' || !value) throw new Error('Invalid string')
  return value
}

function optionalString(value) {
  return typeof value === 'string' && value ? value : undefined
}

function integer(value, fallback) {
  return Number.isInteger(value) ? value : fallback
}
