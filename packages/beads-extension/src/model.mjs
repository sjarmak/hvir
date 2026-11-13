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
  const dependencies = sourceView(
    input.bdDependencies,
    input.bdDependenciesFailure,
    previous?.dependencies,
    parseDependencyEdges,
    'structured bd dependency output',
    { edges: [] },
  )
  const beads = sourceView(
    input.bd,
    input.bdFailure,
    previous?.beads,
    (text, observedAt) =>
      parseBeads(text, observedAt, input.bdReady?.text, dependencies.edges),
    'structured bd output',
  )
  return {
    beads,
    dependencies,
    gates: sourceView(
      input.bdGates,
      input.bdGatesFailure,
      previous?.gates,
      (text, observedAt) => parseGates(text, observedAt, beads.issues),
      'structured bd gate output',
      { gates: [] },
    ),
    crew: sourceView(
      input.gc,
      input.gcFailure,
      previous?.crew,
      (text, observedAt) =>
        parseCrew(
          text,
          observedAt,
          input.bd,
          input.bdReady,
          previous?.beads,
          input.gcRig?.text,
        ),
      'structured gc output',
    ),
  }
}

function sourceView(source, failure, previous, parse, label, empty = emptySource()) {
  if (failure)
    return {
      ...(previous ?? empty),
      state: 'error',
      message: failure.message,
      observedAt: failure.observedAt,
    }
  if (!source)
    return {
      ...(previous ?? empty),
      state: 'unavailable',
      message: `${label} is unavailable`,
    }
  try {
    return parse(source.text, source.observedAt)
  } catch {
    return {
      ...(previous ?? empty),
      state: 'error',
      message: `Invalid ${label}`,
      observedAt: source.observedAt,
    }
  }
}

export function parseGates(text, observedAt, issues = []) {
  const raw = JSON.parse(text)
  if (!Array.isArray(raw)) throw new Error('Invalid structured bd gate output')
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const gates = raw.map(readGate).map((gate) => ({
    gate,
    ...(gate.blockedId && byId.has(gate.blockedId)
      ? {
          blocks: {
            id: gate.blockedId,
            title: byId.get(gate.blockedId).title,
          },
        }
      : {}),
  }))
  return {
    state: gates.length ? 'ready' : 'empty',
    observedAt,
    gates,
  }
}

function readGate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid gate')
  const id = string(value.id)
  const blockedId = optionalString(value.blocked_id ?? value.issue_id ?? value.blocks)
  return {
    id,
    title: optionalString(value.title) ?? id,
    gateType: optionalString(value.gate_type ?? value.type) ?? 'human',
    state: optionalString(value.state ?? value.status) ?? 'open',
    ...(blockedId ? { blockedId } : {}),
  }
}

function emptySource() {
  return { sections: [], groups: [] }
}

export function parseBeads(text, observedAt, readyText, dependencyEdges = []) {
  const raw = JSON.parse(text)
  const rawReady = JSON.parse(readyText)
  if (!Array.isArray(raw)) throw new Error('Invalid structured bd output')
  if (!Array.isArray(rawReady)) throw new Error('Invalid structured bd output')
  const issues = enrichDependencies(raw.map(readIssue), dependencyEdges)
  const buckets = new Map(sectionOrder.map(([key]) => [key, []]))
  const ready = new Set(
    rawReady
      .map(readIssue)
      .filter((issue) => issue.status === 'open')
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
    else if (
      issue.status === 'blocked' ||
      issue.blockedBy.length > 0
    )
      key = 'blocked'
    else if (shipState(issue, category)) key = 'ready-to-ship'
    else if (category === 'executable-leaf' && ready.has(issue.id))
      key = 'dependency-ready'
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

export function parseDependencyEdges(text, observedAt) {
  const edges = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    const [blockedId, relation, blockerId, type, ...extra] = line.trim().split(/\s+/u)
    if (!blockedId || relation !== 'dependsOn' || !blockerId || !type || extra.length)
      throw new Error('Invalid dependency edge')
    if (type !== 'blocks' || blockerId === blockedId) continue
    const key = `${blockerId}\0${blockedId}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ blockerId, blockedId })
  }
  return { state: edges.length ? 'ready' : 'empty', observedAt, edges }
}

function enrichDependencies(issues, edges) {
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const blockedBy = new Map()
  const unlocks = new Map()
  for (const edge of edges) {
    if (!byId.has(edge.blockedId) || !byId.has(edge.blockerId)) continue
    appendId(blockedBy, edge.blockedId, edge.blockerId)
    appendId(unlocks, edge.blockerId, edge.blockedId)
  }
  const reference = (id) => {
    const issue = byId.get(id)
    return issue ? { id: issue.id, title: issue.title, status: issue.status } : undefined
  }
  return issues.map((issue) => {
    const blockers = (blockedBy.get(issue.id) ?? []).map(reference).filter(Boolean)
    const unlocked = (unlocks.get(issue.id) ?? []).map(reference).filter(Boolean)
    const firstBlocker = blockers[0]
    const blocker = firstBlocker ? byId.get(firstBlocker.id) : undefined
    return {
      ...issue,
      blockedBy: blockers,
      unlocks: unlocked,
      unlocksCount: unlocked.length,
      ...(firstBlocker
        ? {
            nextUnblock: {
              action: `Resolve “${firstBlocker.title}”`,
              ...(blocker?.assignee ? { owner: blocker.assignee } : {}),
            },
          }
        : {}),
    }
  })
}

function appendId(collection, key, value) {
  collection.set(key, [...(collection.get(key) ?? []), value])
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

export function parseCrew(
  text,
  observedAt,
  bdSource,
  bdReadySource,
  previousBeads,
  rigText,
) {
  const raw = JSON.parse(text)
  if (!raw || raw.ok !== true || !Array.isArray(raw.sessions))
    throw new Error('Invalid structured gc output')
  let issues = previousBeads?.issues ?? []
  if (bdSource) {
    try {
      issues = parseBeads(bdSource.text, bdSource.observedAt, bdReadySource?.text).issues
    } catch {
      issues = previousBeads?.issues ?? []
    }
  }
  const scope = readCrewScope(rigText)
  const sessions = raw.sessions.filter((session) => crewSessionInScope(session, scope))
  const members = sessions.map((session) => crewMember(session, issues))
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

function readCrewScope(text) {
  const value = JSON.parse(text)
  if (!value || value.ok !== true || !value.rig || typeof value.rig !== 'object')
    throw new Error('Invalid structured gc rig output')
  const name = string(value.rig.name)
  const path = normalizedPath(string(value.rig.path))
  const cityPath = normalizedPath(string(value.city_path ?? value.cityPath))
  return { name, path, city: path === cityPath }
}

function crewSessionInScope(value, scope) {
  if (scope.city) return true
  if (!value || typeof value !== 'object') throw new Error('Invalid crew member')
  const projectedRig = optionalString(value.rig)
  if (projectedRig) return projectedRig === scope.name
  const identity = optionalString(value.template) ?? optionalString(value.name)
  if (identity?.startsWith('/'))
    return normalizedPath(identity.slice(0, identity.lastIndexOf('/'))) === scope.path
  if (identity?.startsWith(`${scope.name}/`)) return true
  const workDir = optionalString(value.work_dir ?? value.workDir)
  return workDir ? pathAtOrBelow(workDir, scope.path) : false
}

function normalizedPath(value) {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

function pathAtOrBelow(value, root) {
  const path = normalizedPath(value)
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
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
