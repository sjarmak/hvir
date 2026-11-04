;(() => {
  const el = (...args) => window.el(...args)
  const text = (value, className = '') => el('span', { className }, value)
  const paragraph = (value, className = '') => el('p', { className }, value)
  const list = (items, empty) => el('ul', {}, ...(
    items.length ? items : [el('li', { className: 'hvir-meta' }, empty)]))
  const section = (title, ...children) => el('section', {}, el('h2', {}, title), ...children)
  const chip = (state) => {
    const node = text(state.replaceAll('-', ' '), 'projects-chip')
    node.dataset.state = state
    return node
  }
  const button = (label, title, action) => {
    const node = el('button', { type: 'button', className: 'hvir-button', title }, label)
    node.addEventListener('click', action)
    return node
  }

  const renderRefs = (refs, options) => {
    const chips = ['prs', 'issues'].flatMap((field) => refs[field].map((ref) => {
      const label = [`${field === 'prs' ? 'PR' : 'Issue'} ${ref.key}`, ref.state, ref.review, ref.checks].filter(Boolean).join(' · ')
      const node = button(label,
        ref.title || ref.key, () => options.onOpenRef?.({ ...ref, kind: field === 'prs' ? 'pr' : 'issue' }))
      node.dataset.state = ref.state || 'unknown'
      return node
    }))
    return el('div', { className: 'projects-refs' }, ...chips,
      refs.invalid.length > 0 && text(refs.invalid.length === 1 ? 'link missing' : `${refs.invalid.length} links missing`, 'projects-warning'))
  }

  const renderAsk = (ask, options, tagged = false) => el('li', {},
    tagged && text(ask.project?.title ?? 'No project', 'projects-tag'),
    button(ask.title, ask.id, () => options.onOpenBead?.(ask.id, ask.store)),
    renderRefs(ask.refs, options))

  const renderActivity = (item) => {
    const flow = item.workflow
    const formula = flow ? `${flow.formula || 'Unnamed workflow'} · ${flow.step || 'Step unknown'} · ${flow.stepsDone}/${flow.stepsTotal} steps done` : ''
    const age = item.startedAt ? window.ago(item.startedAt) : ''
    return el('li', { className: 'projects-activity', title: item.bead?.id ?? '' },
      el('div', {}, text(item.session, 'projects-session'),
        item.kind === 'seat-job' && text('Seat job', 'projects-tag')),
      text(item.bead?.title ?? 'No assigned work'),
      text([formula, item.model, item.account, age && `Running ${age.replace(/ ago$/, '')}`].filter(Boolean).join(' · '), 'hvir-meta'))
  }

  const renderOutcome = (entry) => el('li', {},
    text(entry.title), entry.outcome && paragraph(entry.outcome, 'hvir-meta'),
    text(`${entry.time} · ${window.ago(entry.time.replace(/Z$/, ':00Z'))}`, 'hvir-meta'))

  const renderMilestone = (entry, options) => el('li', { title: entry.id },
    text(entry.target || 'No target', 'hvir-meta'),
    text(entry.title), chip(entry.state),
    entry.outcome && paragraph(entry.outcome), renderRefs(entry.refs, options))

  const STATE_LABELS = { tested: 'Tested', installed: 'Installed', live: 'Live' }

  const renderArtifactState = (state) => el('li', { className: 'projects-artifact-state' },
    text(STATE_LABELS[state.name]),
    state.claimed
      ? text(` · since ${state.at || 'unknown'} · checked ${state.checkedAt || 'unknown'} · ${state.source || 'no source recorded'}`, 'hvir-meta')
      : text(' · not claimed', 'hvir-meta'),
    state.stale && text(' · not checked in 24h', 'projects-warning'))

  const renderArtifact = (entry) => el('li', { className: 'projects-artifact', title: entry.id },
    text(entry.ref || 'No reference', 'projects-session'),
    text(` · ${[entry.kind || 'unknown kind', entry.closed && 'closed'].filter(Boolean).join(' · ')}`, 'hvir-meta'),
    el('ul', {}, ...entry.states.map(renderArtifactState)))

  const renderWorkflow = (flow) => el('li', { title: flow.rootId },
    text(flow.formula || 'Unnamed workflow', 'projects-session'),
    text(` · ${flow.stepsDone}/${flow.stepsTotal} steps done`),
    paragraph(flow.running.length ? flow.running.map((item) =>
      `${item.step || 'Step unknown'} · ${item.session}`).join('; ') : 'No active workers', 'hvir-meta'))

  const renderDetail = (card, options) => el('div', { className: 'projects-detail' },
    section('Milestones', list(card.milestoneList.map((entry) => renderMilestone(entry, options)), 'No milestones')),
    section('Needs you', list(card.decisions.filter((ask) => ask.needsYou)
      .map((ask) => renderAsk(ask, options)), 'Nothing needs you')),
    section('Answered, waiting on agents', list(card.decisions.filter((ask) => ask.inDelivery)
      .map((ask) => renderAsk(ask, options)), 'Nothing waiting')),
    card.decisions.some((ask) => !ask.needsYou && !ask.inDelivery) && section('Other open decisions',
      list(card.decisions.filter((ask) => !ask.needsYou && !ask.inDelivery).map((ask) => renderAsk(ask, options)), '')),
    section('Workflows', list(card.workflows.map(renderWorkflow), 'No workflows')),
    options.outcomesShown && section('Asks and outcomes', list(card.outcomes.map(renderOutcome), 'No outcomes yet')),
    el('details', {}, el('summary', {}, `In progress (${card.inProgress.length})`),
      list(card.inProgress.map((bead) => el('li', {},
        button(bead.title, bead.id, () => options.onOpenBead?.(bead.id, bead.store)),
        text(bead.assignee && ` · ${bead.assignee}`, 'hvir-meta'))), 'Nothing in progress')))

  const renderProgress = (milestones) => {
    const { done, total, next } = milestones
    return el('div', { className: 'projects-progress' },
      el('label', {}, `${done}/${total} milestones done`,
        el('progress', { max: total || 1, value: done, title: `${done} of ${total} milestones done` })),
      paragraph(next ? `Next: ${next.title} · ${next.target || 'No target'}` : 'No next milestone', 'hvir-meta'))
  }

  const summary = (card, options) => [
      card.contributors.length > 0 && paragraph(`With ${card.contributors.join(', ')}`, 'hvir-meta'),
      paragraph(card.now || 'No current update'),
      card.stuckWhy && paragraph(card.stuckWhy, 'projects-warning'),
      renderProgress(card.milestones),
      options.outcomesShown && section('Recent outcomes', list(card.outcomes.slice(0, 3).map(renderOutcome), 'No outcomes yet')),
      paragraph(`${card.needsCount} ${card.needsCount === 1 ? 'decision needs' : 'decisions need'} you`),
      renderRefs(card.refs, options),
      section('Active now', list(card.active.map(renderActivity), 'No active agents')),
      card.stale && paragraph('not updated in 24h', 'projects-warning'),
      paragraph(card.updatedAt ? `Updated ${card.updatedAt} · ${window.ago(card.updatedAt)}` : 'Update time unknown', 'hvir-meta')]
    .filter(Boolean)

  const renderCard = (card, options) => {
    const detail = renderDetail(card, options)
    detail.hidden = true
    const toggle = button('Show details', card.id, () => {
      detail.hidden = !detail.hidden
      toggle.textContent = detail.hidden ? 'Show details' : 'Hide details'
      toggle.setAttribute('aria-expanded', String(!detail.hidden))
    })
    toggle.setAttribute('aria-expanded', 'false')
    const face = el('div', { className: 'projects-card-face' },
      el('header', {}, el('h3', { title: card.id }, card.title), chip(card.state)),
      ...summary(card, options),
      el('div', { className: 'projects-card-actions' }, toggle,
        options.onOpenProject && button('Open page', card.id, () => options.onOpenProject(card.id, card.store))))
    face.addEventListener('click', (event) => {
      if (!event.target.closest('button, a')) toggle.click()
    })
    return el('article', { className: 'projects-card' }, face, detail)
  }

  const renderDashboard = (model, root, given = {}) => {
    const options = { ...given, outcomesShown: model.outcomesShown }
    root.classList.add('projects-dashboard')
    const activeGroups = model.activeNow.map((group) => el('div', { className: 'projects-active-group' },
      el('h3', {}, group.project?.title ?? 'No project'), list(group.items.map(renderActivity), 'No active agents')))
    root.replaceChildren(
      section('Needs you', list(model.needsYou.map((ask) => renderAsk(ask, options, true)), 'Nothing needs you')),
      section('Active now', el('div', { className: 'projects-active-grid' }, ...activeGroups),
        !activeGroups.length && paragraph('No active agents', 'hvir-meta'),
        options.seatJobsUnavailable && paragraph('Seat jobs not shown yet', 'hvir-meta')),
      ...model.cards.map((group) => section(group.lead,
        el('div', { className: 'projects-grid' }, ...group.cards.map((card) => renderCard(card, options))))))
  }

  const tile = (label, value) => el('div', { className: 'projects-tile' }, text(label, 'hvir-meta'), el('strong', {}, value))

  const glance = (card) => el('div', { className: 'projects-glance' },
    tile('State', chip(card.state)),
    tile('Lead', card.lead),
    tile('Milestones', `${card.milestones.done}/${card.milestones.total}`),
    tile('Needs you', String(card.needsCount)),
    tile('Agents active', String(card.active.length)),
    tile('Updated', card.updatedAt ? window.ago(card.updatedAt) : 'unknown'))

  const decisionSections = (card, options) => {
    const pick = (test) => card.decisions.filter(test).map((ask) => renderAsk(ask, options))
    const other = pick((ask) => !ask.needsYou && !ask.inDelivery)
    return [
      section('Needs you', list(pick((ask) => ask.needsYou), 'Nothing needs you')),
      section('Answered, waiting on agents', list(pick((ask) => ask.inDelivery), 'Nothing waiting')),
      other.length > 0 && section('Other open decisions', list(other, '')),
    ].filter(Boolean)
  }

  const renderProject = (card, root, options = {}) => {
    root.classList.add('projects-dashboard', 'projects-page')
    const back = button('← All projects', 'Back to the overview', () => options.onOpenOverview?.())
    back.classList.add('projects-back')
    const refs = card.refs.prs.length + card.refs.issues.length + card.refs.invalid.length
    root.replaceChildren(
      back,
      el('header', {}, el('h1', { title: card.id }, card.title)),
      glance(card),
      el('div', { className: 'projects-page-grid' },
        el('div', {},
          section('Now', paragraph(card.now || 'No current update'),
            card.stuckWhy && paragraph(card.stuckWhy, 'projects-warning'),
            card.blocker && paragraph(`Blocker: ${card.blocker}`, 'projects-warning'),
            card.nextAction && paragraph(`Next step: ${card.nextAction}`),
            card.contributors.length > 0 && paragraph(`With ${card.contributors.join(', ')}`, 'hvir-meta'),
            card.stale && paragraph('not updated in 24h', 'projects-warning')),
          section('Milestones', renderProgress(card.milestones),
            list(card.milestoneList.map((entry) => renderMilestone(entry, options)), 'No milestones')),
          section('Artifacts', list(card.artifacts.map(renderArtifact), 'No artifacts recorded')),
          section('Workflows', list(card.workflows.map(renderWorkflow), 'No workflows')),
          options.outcomesShown && section('Asks and outcomes', list(card.outcomes.map(renderOutcome), 'No outcomes yet'))),
        el('div', {},
          ...decisionSections(card, options),
          refs > 0 && section('Pull requests and issues', renderRefs(card.refs, options)),
          section('Active now', list(card.active.map(renderActivity), 'No active agents')),
          section(`In progress (${card.inProgress.length})`, list(card.inProgress.map((bead) => el('li', {},
            button(bead.title, bead.id, () => options.onOpenBead?.(bead.id, bead.store)),
            text(bead.assignee && ` · ${bead.assignee}`, 'hvir-meta'))), 'Nothing in progress')))))
  }

  const navRow = (card, options) => {
    const needs = card.needsCount === 1 ? '1 needs you' : card.needsCount > 1 ? `${card.needsCount} need you` : ''
    const meta = [needs, `${card.milestones.done}/${card.milestones.total} milestones`,
      card.stale && 'not updated in 24h'].filter(Boolean).join(' · ')
    const row = el('button', { type: 'button', className: 'projects-nav-row', title: card.id },
      el('span', { className: 'projects-nav-title' }, card.title), chip(card.state), text(meta, 'hvir-meta'))
    row.addEventListener('click', () => options.onOpenProject?.(card.id, card.store))
    return el('li', {}, row)
  }

  const renderNav = (model, root, options = {}) => {
    root.classList.add('projects-nav')
    const overview = button('Open overview', 'All projects on one page', () => options.onOpenOverview?.())
    overview.classList.add('projects-nav-overview')
    root.replaceChildren(
      paragraph(`${model.needsYou.length} need you · ${model.inDelivery.length} answered, waiting on agents`, 'projects-nav-counts'),
      overview,
      section('Needs you', list(model.needsYou.map((ask) => renderAsk(ask, options, true)), 'Nothing needs you')),
      ...model.cards.map((group) => section(group.lead, el('ul', {}, ...group.cards.map((card) => navRow(card, options))))))
  }

  window.projectsRender = Object.freeze({ renderDashboard, renderNav, renderProject })
})()
