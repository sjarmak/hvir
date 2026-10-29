;(() => {
  const meta = (bead, key) => bead?.metadata?.[key] ?? ''
  const identity = (bead) => bead ? { id: bead.id, title: bead.title,
    ...(bead.store === undefined ? {} : { store: bead.store }) } : null
  const tokens = (value) => value ? value.split(',') : []

  const parseRefs = (value) => {
    const refs = []
    const invalid = []
    if (value === undefined || value === null || value === '') return { refs, invalid }
    if (typeof value !== 'string') return { refs, invalid: [value] }
    for (const key of value.split(',')) {
      const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(key)
      if (!match || match[0] !== key) invalid.push(key)
      else refs.push({ owner: match[1], repo: match[2], number: Number(match[3]), key })
    }
    return { refs, invalid }
  }

  const references = (beads, states) => {
    const result = { prs: [], issues: [], invalid: [] }
    for (const field of ['prs', 'issues']) {
      const seen = new Set()
      for (const bead of beads) {
        const parsed = parseRefs(meta(bead, `ref.${field}`))
        result.invalid.push(...parsed.invalid)
        for (const ref of parsed.refs) {
          if (seen.has(ref.key)) continue
          seen.add(ref.key)
          result[field].push({ ...states[ref.key], ...ref })
        }
      }
    }
    return result
  }

  const parents = (bead) => [...new Set([
    bead?.parent,
    ...(bead?.dependencies ?? [])
      .filter((dependency) => (dependency.type ?? dependency.dependency_type) === 'parent-child')
      .map((dependency) => dependency.depends_on_id ?? dependency.id),
  ].filter(Boolean))]

  const workflowRoot = (bead, index) => {
    const root = index.get(meta(bead, 'gc.root_bead_id'))
    return meta(root, 'gc.kind') === 'workflow' ? root : null
  }

  const resolveProject = (bead, index, projects) => {
    const root = workflowRoot(bead, index)
    const direct = meta(bead, 'proj.id') || meta(root, 'proj.id')
    if (direct) return projects.get(direct) ?? null
    const pending = [bead, root].filter(Boolean)
    const seen = new Set()
    while (pending.length) {
      const current = pending.shift()
      if (seen.has(current.id)) continue
      seen.add(current.id)
      if (projects.has(current.id)) return projects.get(current.id)
      const linked = meta(current, 'proj.id')
      if (linked) return projects.get(linked) ?? null
      pending.push(...parents(current).map((id) => index.get(id)).filter(Boolean))
    }
    return null
  }

  const workflow = (root, step, steps) => {
    const children = steps.filter((bead) => meta(bead, 'gc.root_bead_id') === root.id)
    return {
      rootId: root.id,
      formula: meta(root, 'gc.formula_name'),
      step: meta(step, 'gc.step_id'),
      stepsDone: children.filter((bead) => bead.status === 'closed').length,
      stepsTotal: children.length,
    }
  }

  const modelName = (command, provider) => {
    if (Array.isArray(command)) {
      const position = command.indexOf('--model')
      return (position >= 0 ? command[position + 1] : null) || provider || ''
    }
    const match = /(?:^|\s)--model\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command ?? '')
    return match ? match[1] ?? match[2] ?? match[3] : provider || ''
  }

  const collectActivity = (input, index, projects) => {
    const entries = []
    const add = (source, bead, kind) => {
      const root = workflowRoot(bead, index)
      entries.push({
        project: identity(resolveProject(bead, index, projects)),
        item: {
          session: source.name,
          agent: source.agent_name ?? '',
          account: source.account ?? '',
          model: modelName(source.command, source.provider),
          startedAt: source.started_at ?? null,
          bead: identity(bead),
          workflow: root ? workflow(root, bead, input.workflowSteps ?? []) : null,
          kind,
        },
      })
    }
    const seen = new Set()
    for (const session of input.sessions ?? []) {
      const key = session.id ?? session.name
      if (seen.has(key)) continue
      seen.add(key)
      const assignees = [session.id, session.name, session.agent_name].filter(Boolean)
      const bead = (input.inProgress ?? []).find((entry) =>
        entry.status === 'in_progress' && assignees.includes(entry.assignee))
      add(session, bead, 'session')
    }
    for (const { seat, label, job, alive } of input.seatJobs ?? []) {
      if (!alive || !job) continue
      add({ name: `${seat} / ${label}`, agent_name: seat, command: job.argv,
        provider: job.account, account: job.account, started_at: job.started_at }, index.get(job.bead), 'seat-job')
    }
    return entries
  }

  const milestone = (bead, states) => ({
    ...identity(bead),
    target: meta(bead, 'ms.target'),
    state: meta(bead, 'ms.state') || 'unknown',
    outcome: meta(bead, 'ms.outcome'),
    refs: references([bead], states),
  })

  const projectWorkflows = (input, index, projects, project, active) =>
    (input.workflowRoots ?? [])
      .filter((root) => meta(root, 'gc.kind') === 'workflow' &&
        resolveProject(root, index, projects)?.id === project.id)
      .map((root) => ({
        ...workflow(root, null, input.workflowSteps ?? []),
        running: active.filter((item) => item.workflow?.rootId === root.id)
          .map((item) => ({ session: item.session, step: item.workflow.step })),
      }))

  const buildCard = (project, context) => {
    const { input, index, projects, needsYou, openDecisions, entries, states } = context
    const list = (input.milestones ?? []).filter((bead) => parents(bead).includes(project.id))
      .map((bead) => milestone(bead, states))
      .sort((a, b) => a.target.localeCompare(b.target) || a.id.localeCompare(b.id))
    const next = list.find((entry) => entry.id === meta(project, 'proj.next_milestone'))
    const active = entries.filter((entry) => entry.project?.id === project.id).map((entry) => entry.item)
    const decisions = openDecisions.filter((ask) => ask.project?.id === project.id)
    const state = meta(project, 'proj.state') || 'unknown'
    const updatedAt = meta(project, 'proj.updated_at') || null
    return {
      ...identity(project),
      lead: meta(project, 'proj.lead') || 'Unknown lead',
      contributors: tokens(meta(project, 'proj.contributors')),
      state,
      now: meta(project, 'proj.now'),
      stuckWhy: meta(project, 'proj.stuck_why'),
      updatedAt,
      stale: state !== 'done' && !(Date.parse(input.now) - Date.parse(updatedAt) <= 86400000),
      milestones: {
        done: list.filter((entry) => entry.state === 'done').length,
        total: list.filter((entry) => entry.state !== 'dropped').length,
        next: next ? { ...identity(next), target: next.target, state: next.state } : null,
      },
      milestoneList: list,
      needsCount: needsYou.filter((ask) => ask.project?.id === project.id).length,
      refs: references([project, ...(input.milestones ?? []).filter((bead) =>
        parents(bead).includes(project.id)), ...decisions], states),
      active,
      inProgress: (input.inProgress ?? [])
        .filter((bead) => bead.status === 'in_progress' && resolveProject(bead, index, projects)?.id === project.id)
        .map((bead) => ({ ...identity(bead), assignee: bead.assignee ?? '' })),
      decisions,
      workflows: projectWorkflows(input, index, projects, project, active),
      outcomes: (input.outcomes ?? []).filter((entry) => entry.projects.includes(project.id)),
    }
  }

  const groupActivity = (entries) => {
    const groups = new Map()
    for (const { project, item } of entries) {
      const key = project?.id ?? null
      if (!groups.has(key)) groups.set(key, { project, label: project?.title ?? 'No project', items: [] })
      groups.get(key).items.push(item)
    }
    return [...groups.values()]
  }

  const buildDashboard = (input) => {
    const beads = ['ancestors', 'workflowSteps', 'workflowRoots', 'inProgress', 'decisions', 'milestones', 'projects']
      .flatMap((key) => input[key] ?? [])
    const index = new Map(beads.map((bead) => [bead.id, bead]))
    const projects = new Map((input.projects ?? []).map((bead) => [bead.id, bead]))
    const states = input.refStates ?? {}
    const openDecisions = (input.decisions ?? []).filter((bead) => bead.status === 'open')
      .map((bead) => ({ ...bead, project: identity(projects.get(meta(bead, 'gc.project'))),
        refs: references([bead], states) }))
    const needsYou = openDecisions.filter((bead) => (bead.labels ?? []).some((label) =>
      label.toLowerCase() === 'needs/stephanie') && !(meta(bead, 'gc.answered')?.length > 0))
    const entries = collectActivity(input, index, projects)
    const groups = new Map()
    for (const project of projects.values()) {
      const card = buildCard(project, { input, index, projects, needsYou, openDecisions, entries, states })
      if (!groups.has(card.lead)) groups.set(card.lead, { lead: card.lead, cards: [] })
      groups.get(card.lead).cards.push(card)
    }
    return { now: input.now, needsYou, cards: [...groups.values()], activeNow: groupActivity(entries),
      outcomesShown: Array.isArray(input.outcomes) }
  }

  const duplicateProjects = (projects = []) => {
    const stores = new Map()
    for (const bead of projects) stores.set(bead.id, new Set([...(stores.get(bead.id) ?? []), bead.store]))
    return [...stores].filter(([, found]) => found.size > 1).map(([id]) => id)
  }

  const api = Object.freeze({ parseRefs, buildDashboard, duplicateProjects })
  if (typeof module === 'object') module.exports = api
  else window.projectsModel = api
})()
