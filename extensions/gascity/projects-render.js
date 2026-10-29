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
      const status = [ref.state || 'state unknown', ref.review, ref.checks].filter(Boolean).join(' · ')
      const node = button(`${field === 'prs' ? 'PR' : 'Issue'} ${ref.key} · ${status}`,
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

  const renderWorkflow = (flow) => el('li', { title: flow.rootId },
    text(flow.formula || 'Unnamed workflow', 'projects-session'),
    text(` · ${flow.stepsDone}/${flow.stepsTotal} steps done`),
    paragraph(flow.running.length ? flow.running.map((item) =>
      `${item.step || 'Step unknown'} · ${item.session}`).join('; ') : 'No active workers', 'hvir-meta'))

  const renderDetail = (card, options) => el('div', { className: 'projects-detail' },
    section('Milestones', list(card.milestoneList.map((entry) => renderMilestone(entry, options)), 'No milestones')),
    section('Open decisions', list(card.decisions.map((ask) => renderAsk(ask, options)), 'No open decisions')),
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
      card.contributors.length > 0 && paragraph(`With ${card.contributors.join(', ')}`, 'hvir-meta'),
      paragraph(card.now || 'No current update'),
      card.stuckWhy && paragraph(card.stuckWhy, 'projects-warning'),
      renderProgress(card.milestones),
      options.outcomesShown && section('Recent outcomes', list(card.outcomes.slice(0, 3).map(renderOutcome), 'No outcomes yet')),
      paragraph(`${card.needsCount} ${card.needsCount === 1 ? 'decision needs' : 'decisions need'} you`),
      renderRefs(card.refs, options),
      section('Active now', list(card.active.map(renderActivity), 'No active agents')),
      card.stale && paragraph('not updated in 24h', 'projects-warning'),
      paragraph(card.updatedAt ? `Updated ${card.updatedAt} · ${window.ago(card.updatedAt)}` : 'Update time unknown', 'hvir-meta'),
      toggle)
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

  window.projectsRender = Object.freeze({ renderDashboard })
})()
