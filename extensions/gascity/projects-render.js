;(() => {
  const el = (...args) => window.el(...args)
  const text = (value, className = '') => el('span', { className }, value)
  const paragraph = (value, className = '') => el('p', { className }, value)
  const list = (items, empty) => el('ul', {}, ...(
    items.length ? items : [el('li', { className: 'hvir-meta' }, empty)]))
  const section = (title, ...children) => el('section', {}, el('h2', {}, title), ...children)
  const needsList = (items, options = {}) => options.needsUnchecked
    ? [paragraph(options.needsUnchecked, 'projects-warning projects-needs-unchecked'), items.length > 0 && el('ul', {}, ...items)]
    : [list(items, 'Nothing needs you')]
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

  const SEAT_NAMES = Object.freeze({
    mayor: 'Wren',
    'omni-pl': 'Verity',
    'omni-evals-pl': 'Caliper',
    'city-infra-pl': 'Tessera',
    'omni-evals-desk': 'the evals desk',
  })

  const renderAnswerTo = (ask, options) => {
    if (!ask.answerTo) return null
    const name = SEAT_NAMES[ask.answerTo]
    const label = `Owner: ${name ? `${name} (${ask.answerTo})` : ask.answerTo}`
    const owner = options.onAttachSeat
      ? button(label, `Open the ${ask.answerTo} session in a terminal`, () => options.onAttachSeat(ask.answerTo))
      : text(label, 'hvir-meta')
    return el('div', {}, owner,
      !ask.answerLive && paragraph(name ? `${name} is asleep` : `The ${ask.answerTo} session is asleep`, 'hvir-meta'))
  }

  const OPTION_LABEL_MAX = 48
  const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
  const ANSWER_TONES = Object.freeze({ done: 'done', warning: 'warning', unknown: 'warning', idle: 'error' })
  const UNKNOWN_RESULT = Object.freeze({ unknown: true, line: 'Completion unknown; check the decision before answering again' })

  const outcomeNote = (entry) => {
    const tone = ANSWER_TONES[entry.phase]
    const note = paragraph(entry.result.line, tone === 'warning' ? 'projects-warning' : 'hvir-meta')
    note.dataset.state = tone
    if (tone === 'error') note.classList.add('projects-error')
    return note
  }

  const renderAnswer = (ask, options) => {
    if (!ask.needsYou || !options.onAnswer || ask.metadata?.['gc.answered']) return null
    const choices = window.needsModel.parseOptions(ask)
    if (choices.length === 0) return null
    const store = window.answerState
    const choiceButtons = []
    const confirmBox = el('div', { className: 'projects-confirm' })
    const outcome = el('div', { className: 'projects-answer-outcome' })
    const container = el('div', { className: 'projects-answer' }, confirmBox, outcome)
    let key
    const disableAll = (disabled) => {
      for (const node of [...choiceButtons, ...confirmBox.querySelectorAll('button')]) node.disabled = disabled
    }
    const sync = (entry) => {
      if (!container.isConnected) return false
      const locked = entry.phase !== 'idle'
      disableAll(locked)
      if (locked) confirmBox.replaceChildren()
      outcome.replaceChildren(...(entry.result ? [outcomeNote(entry)] : []))
      return true
    }
    const show = (result) => outcome.replaceChildren(outcomeNote({ phase: 'idle', result }))
    const fingerprint = async (submitting = false) => {
      try {
        const sha = await window.needsModel.cardHash(ask)
        if (sha) return sha
        throw new Error('This card cannot be fingerprinted')
      } catch (error) {
        if (!submitting && choiceButtons.some((node) => node.disabled)) return null
        disableAll(false)
        confirmBox.replaceChildren()
        show({ exitCode: 2, line: `No answer was sent: ${error.message}` })
        return null
      }
    }
    const settle = async (choice) => {
      disableAll(true)
      const sha = await fingerprint(true)
      if (!sha) return
      key = store.keyOf(options.workspaceId, ask.id, sha)
      store.subscribe(key, sync)
      if (!store.begin(key)) return
      let result
      try {
        result = await options.onAnswer(ask.id, choice.letter, sha)
      } catch {
        result = UNKNOWN_RESULT
      }
      store.finish(key, result)
    }
    const askToConfirm = (choice) => {
      outcome.replaceChildren()
      confirmBox.replaceChildren(
        paragraph(`Record ${choice.letter}: ${choice.text} as your answer to ${ask.title}?`),
        button('Confirm', `Record ${choice.letter}`, () => void settle(choice)),
        button('Cancel', 'Keep the card as it is', () => confirmBox.replaceChildren()))
    }
    choiceButtons.push(...choices.map((choice) => button(
      `${choice.letter}: ${clip(choice.text, OPTION_LABEL_MAX)}`, choice.text, () => askToConfirm(choice))))
    container.prepend(...choiceButtons)
    void fingerprint().then((sha) => {
      if (!sha) return
      key = store.keyOf(options.workspaceId, ask.id, sha)
      store.subscribe(key, sync)
      if (!outcome.hasChildNodes()) sync(store.get(key))
    })
    return container
  }

  const cardButton = (cardText, id, action) => {
    const node = button(cardText, id, action)
    node.classList.add('projects-card-text')
    return node
  }

  const renderAsk = (ask, options, tagged = false) => {
    const open = () => options.onOpenBead?.(ask.id, ask.store)
    return el('li', { title: ask.id },
      tagged && text(ask.project?.title ?? 'No project', 'projects-tag'),
      ask.tier && text(ask.tier, 'projects-tag'),
      ask.cardText ? cardButton(ask.cardText, ask.id, open) : button(ask.title, ask.id, open),
      renderAnswer(ask, options),
      renderAnswerTo(ask, options),
      renderRefs(ask.refs, options))
  }

  const renderStep = (entry, options) => {
    const open = () => options.onOpenBead?.(entry.id, entry.store)
    return el('li', { className: 'projects-step', title: entry.id },
      entry.scope && text(entry.scope, 'projects-tag'),
      ...(entry.cardText ? [cardButton(entry.cardText, entry.id, open)]
        : [button(entry.step || `No step written: ${entry.title || entry.id}`, entry.id, open), text(entry.id, 'hvir-meta')]))
  }

  const stepSection = (model, options) => ((model.herSteps ?? []).length > 0 || model.stepsUnread) &&
    section('Your next step', list((model.herSteps ?? []).map((entry) => renderStep(entry, options)), ''),
      model.stepsUnread && paragraph('Some steps could not be read', 'projects-warning'))

  const flag = (label) => text(label, 'projects-flag')
  const statusLine = (row, now) => paragraph(window.cardWords.statusLine(row, now), 'projects-status-line')

  const BROKEN_WAIT = Object.freeze({ her: 'you', decision: 'a decision', agent: 'an agent' })
  const STUCK_REASONS = Object.freeze({
    'broken-wait': (row) => `waiting on ${BROKEN_WAIT[row.waitKind] ?? 'a recorded wait'} for over a day`,
    'no-movement': () => 'no movement for over an hour',
    unowned: () => 'open with no assignee and no route',
  })

  const stuckWhy = (row) => (row.stuckReasons ?? []).length > 0 &&
    text(` · Stuck because: ${row.stuckReasons.map((reason) => STUCK_REASONS[reason](row)).join('; ')}`, 'projects-warning projects-stuck-why')

  const rowFlags = (row, mode) => [mode === 'stuck' && !row.waitingOn && !row.unclaimedBy && flag(window.cardWords.NO_WAIT),
    row.likelyBroken && flag('likely broken')].filter(Boolean)

  const urgentRow = (row, options, mode, now) => {
    const open = () => options.onOpenBead?.(row.id, row.store, row.waitTarget)
    return el('li', { title: row.id },
      row.cardText ? cardButton(row.cardText, row.id, open) : button(row.title || 'Title not read', row.id, open),
      statusLine(row, now), ...rowFlags(row, mode), stuckWhy(row))
  }

  const urgentSection = (title, group, empty, options, mode, now) => {
    const rows = group?.items ?? []
    const more = group?.more ?? 0
    return section(`${title} (${rows.length + more})`,
      list(rows.map((row) => urgentRow(row, options, mode, now)), empty),
      more > 0 && paragraph(`+${more} more`, 'hvir-meta'))
  }

  const urgentSections = (model, options) => [
    urgentSection('Stuck', model.stuck, 'Nothing stuck', options, 'stuck', model.now),
    (model.working?.items.length ?? 0) > 0 && urgentSection('In progress', model.working, '', options, 'working', model.now),
    (model.waiting?.items.length ?? 0) > 0 && urgentSection('Waiting on', model.waiting, '', options, 'waiting', model.now),
    (model.notStarted?.items.length ?? 0) > 0 && urgentSection('Not started or unknown', model.notStarted, '', options, 'not-started', model.now),
  ].filter(Boolean)

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

  const nonEmptyString = (value) => typeof value === 'string' && value !== ''

  const renderMilestone = (entry, options) => el('li', { title: entry.id },
    entry.target && text([`Due ${entry.target}`, entry.targetReason].filter(Boolean).join(' · '), 'hvir-meta'),
    entry.overdue && text(' · overdue', 'projects-warning'),
    text(entry.title), chip(nonEmptyString(entry.projState) ? entry.projState : entry.state),
    entry.now && paragraph(entry.now),
    nonEmptyString(entry.updatedAt) && Number.isFinite(Date.parse(entry.updatedAt)) &&
      text(`updated ${window.ago(entry.updatedAt.replace(/Z$/, ':00Z'))}`, 'hvir-meta'),
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
    card.state !== card.derivedState && paragraph(`Lead's record says ${card.state.replaceAll('-', ' ')}`, 'hvir-meta'),
    section('Dates', renderDates(card)),
    section('Milestones', list(card.milestoneList.map((entry) => renderMilestone(entry, options)), 'No milestones')),
    section('Needs you', ...needsList(card.decisions.filter((ask) => ask.needsYou)
      .map((ask) => renderAsk(ask, options)), options)),
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
      paragraph(next ? [`Next: ${next.title}`, next.target && `due ${next.target}`, next.target && next.targetReason]
        .filter(Boolean).join(' · ') : 'No next milestone', 'hvir-meta'),
      next?.overdue && paragraph('Next milestone is overdue', 'projects-warning'))
  }

  const OWNER_LABELS = { user: (name) => `Action: ${name}`, dot: (name) => `Action: ${name}`,
    agent: (name) => `Action: ${name} (agent)` }
  const WAIT_LABELS = { her: 'her', 'her-decision': 'her decision', 'decision-in-delivery': 'answered decision',
    work: 'work', 'not-linked': 'not linked' }
  const REASON_LABELS = { deadline: 'deadline', dependency: 'dependency', 'evidence-check': 'evidence check' }

  const renderOwner = (card) => {
    const node = paragraph(OWNER_LABELS[card.actionOwner.kind](card.actionOwner.name), 'projects-owner')
    node.dataset.kind = card.actionOwner.kind
    return node
  }

  const unverified = (card) => card.waitsUnread
    ? 'Waits: unverified, linked work or decisions could not be read'
    : 'Waits: unverified, the record does not declare what it waits on'

  const renderWaits = (card) => {
    if (!card.waitsVerified) return paragraph(unverified(card), 'projects-warning projects-unverified')
    return card.waitingOn.length > 0 && paragraph(`Waits on: ${card.waitingOn.map((entry) =>
      `${entry.id} (${[WAIT_LABELS[entry.kind], entry.status, entry.owner && entry.kind === 'work' && entry.owner]
        .filter(Boolean).join(', ')})`).join('; ')}`, 'hvir-meta')
  }

  const renderChecks = (card) => card.checks.map((check) => paragraph(check, 'projects-warning projects-check'))

  const renderEvidence = (card) => card.derivedState !== 'agents-owe' && card.stateEvidence.length > 0 && el('ul', { className: 'projects-evidence' },
    ...card.stateEvidence.map((line) => el('li', {}, line)))

  const renderInDelivery = (card) => card.inDelivery.length > 0 &&
    el('div', { className: 'projects-in-delivery' }, paragraph('Answered, in delivery', 'hvir-meta'),
      el('ul', {}, ...card.inDelivery.map((line) => el('li', {}, line))))

  const renderDeliveryItem = (item) => el('li', {},
    text(item.title), text(` · answered ${item.answered || 'date not recorded'} · ${item.owner || 'owner not recorded'} · ${item.checkpoint}`, 'hvir-meta'),
    item.notes && el('details', {}, el('summary', {}, 'Delivery notes'), paragraph(item.notes, 'hvir-meta')))

  const renderDeliveryList = (card) => card.inDeliveryItems.length > 0 &&
    el('div', { className: 'projects-in-delivery' }, paragraph('Answered, in delivery', 'hvir-meta'),
      el('ul', {}, ...card.inDeliveryItems.map(renderDeliveryItem)))

  const renderTimes = (card) => paragraph([
    `Fetched ${card.fetchedAt ? window.ago(card.fetchedAt) : 'unknown'}`,
    card.verifiedAt ? `last verified progress ${card.verifiedAt} · ${window.ago(card.verifiedAt)}` : 'no verified progress recorded',
  ].join(' · '), 'hvir-meta projects-times')

  const renderDates = (card) => list(card.dates.map((entry) => el('li', {},
    text(entry.label), text([` · ${entry.at || 'none recorded'}`, REASON_LABELS[entry.reason], entry.note].filter(Boolean).join(' · '), 'hvir-meta'),
    entry.overdue && text(' · overdue', 'projects-warning'))), 'No dates')

  const writtenNote = (card) => card.now && card.writtenAt && text(` · written ${window.ago(card.writtenAt)}`, 'hvir-meta')

  const renderStrip = (card) => el('div', { className: 'projects-strip' },
    chip(card.derivedState),
    text(card.now || 'No current update'),
    writtenNote(card),
    card.actionOwner.kind === 'user' && text('Waits on you', 'projects-waits-you'),
    renderWaits(card))

  const changedSince = (card, lastLooked) =>
    Boolean(lastLooked && card.changedAt && Date.parse(card.changedAt) > Date.parse(lastLooked))

  const summary = (card, options) => [
      renderStrip(card),
      renderEvidence(card),
      renderInDelivery(card),
      renderOwner(card),
      ...renderChecks(card),
      card.contributors.length > 0 && paragraph(`With ${card.contributors.join(', ')}`, 'hvir-meta'),
      card.stuckWhy && paragraph(card.stuckWhy, 'projects-warning'),
      renderProgress(card.milestones),
      options.outcomesShown && section('Recent outcomes', list(card.outcomes.slice(0, 3).map(renderOutcome), 'No outcomes yet')),
      paragraph(`${card.needsCount} ${card.needsCount === 1 ? 'decision needs' : 'decisions need'} you`),
      renderRefs(card.refs, options),
      section('Active now', list(card.active.map(renderActivity), 'No active agents')),
      renderTimes(card)]
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
      el('header', {}, el('h3', { title: card.id }, card.title),
        changedSince(card, options.lastLooked) && text('changed', 'projects-changed'), chip(card.derivedState)),
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
      ...[stepSection(model, options)].filter(Boolean),
      section('Needs you', ...needsList(model.needsYou.map((ask) => renderAsk(ask, options, true)), options),
        model.cardTextsInvalid && paragraph('Card text record could not be read', 'projects-warning')),
      ...urgentSections(model, options),
      section('Active now', el('div', { className: 'projects-active-grid' }, ...activeGroups),
        !activeGroups.length && paragraph('No active agents', 'hvir-meta'),
        options.seatJobsUnavailable && paragraph('Seat jobs not shown yet', 'hvir-meta')),
      ...liveGroups(model).map((group) => section(group.lead,
        el('div', { className: 'projects-grid' }, ...group.cards.map((card) => renderCard(card, options))))),
      ...archive(model, options, root))
  }

  const waitName = (entry) => entry.id === 'stephanie' ? el('span', {}, 'you')
    : entry.title ? el('span', {}, entry.title, text(` (${entry.id})`, 'hvir-meta')) : el('span', {}, entry.id)

  const whereLine = (label, ...content) => el('li', {}, text(label, 'projects-where-label'), ...content)

  const renderWhere = (card) => {
    const waits = card.waitingOn.length > 0
      ? card.waitingOn.flatMap((entry, index) => [index > 0 && text('; '), waitName(entry)]).filter(Boolean)
      : [text('nothing')]
    return el('div', { className: 'projects-where' },
      chip(card.state),
      card.state !== card.derivedState && paragraph(`The board and the lead's record disagree: board says ${
        card.derivedState.replaceAll('-', ' ')}, record says ${card.state.replaceAll('-', ' ')}`, 'projects-warning projects-where-disagree'),
      el('ul', {},
        ...[card.now && whereLine('Now', text(card.now), writtenNote(card)),
          card.nextAction && whereLine('Next', text(card.nextAction)),
          whereLine('Waiting on', ...waits),
          card.verifiedAt && whereLine('Last real progress', text(window.ago(card.verifiedAt)))].filter(Boolean)))
  }

  const tile = (label, value) => el('div', { className: 'projects-tile' }, text(label, 'hvir-meta'), el('strong', {}, value))

  const glance = (card) => el('div', { className: 'projects-glance' },
    tile('Action', card.actionOwner.name),
    tile('Waits', card.waitsVerified ? card.waitingOn.map((entry) => entry.id).join(', ') || 'none' : 'unverified'),
    tile('Lead', card.lead),
    tile('Milestones', `${card.milestones.done}/${card.milestones.total}`),
    tile('Needs you', String(card.needsCount)),
    tile('Agents active', String(card.agentsActive)),
    tile('Queued', String(card.queuedTotal)),
    tile('Verified progress', card.verifiedAt ? window.ago(card.verifiedAt) : 'none recorded'))

  const renderFlight = (row, options) => el('li', {},
    button(row.bead.title, row.bead.id, () => options.onOpenBead?.(row.bead.id, row.bead.store)),
    text(` · ${row.who}`, 'hvir-meta'),
    !row.working && text(` · claimed, ${row.claim}`, 'projects-warning'),
    row.model && text(` · ${row.model}`, 'hvir-meta'),
    row.startedAt && text(` · started ${window.ago(row.startedAt)}`, 'hvir-meta'))

  const renderQueued = (entry, options) => el('li', {},
    button(entry.title, entry.id, () => options.onOpenBead?.(entry.id, entry.store)),
    text(entry.owner && ` · ${entry.owner}`, 'hvir-meta'),
    text(entry.waitingOn && ` · waiting on ${entry.waitingOn}`, 'hvir-meta'))

  const decisionSections = (card, options) => {
    const pick = (test) => card.decisions.filter(test).map((ask) => renderAsk(ask, options))
    const other = pick((ask) => !ask.needsYou && !ask.inDelivery)
    return [
      section('Needs you', ...needsList(pick((ask) => ask.needsYou), options)),
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
      renderWhere(card),
      glance(card),
      el('div', { className: 'projects-page-grid' },
        el('div', {},
          section('Now', renderEvidence(card), renderDeliveryList(card), renderOwner(card), renderWaits(card), ...renderChecks(card),
            paragraph(card.now || 'No current update'),
            card.stuckWhy && paragraph(card.stuckWhy, 'projects-warning'),
            card.blocker && paragraph(`Blocker: ${card.blocker}`, 'projects-warning'),
            card.nextAction && paragraph(`Next step: ${card.nextAction}`),
            card.contributors.length > 0 && paragraph(`With ${card.contributors.join(', ')}`, 'hvir-meta'),
            renderTimes(card)),
          section('Dates', renderDates(card)),
          section('Milestones', renderProgress(card.milestones),
            list(card.milestoneList.map((entry) => renderMilestone(entry, options)), 'No milestones')),
          section('Artifacts', list(card.artifacts.map(renderArtifact), 'No artifacts recorded')),
          section('Workflows', list(card.workflows.map(renderWorkflow), 'No workflows')),
          options.outcomesShown && section('Asks and outcomes', list(card.outcomes.map(renderOutcome), 'No outcomes yet'))),
        el('div', {},
          ...decisionSections(card, options),
          refs > 0 && section('Pull requests and issues', renderRefs(card.refs, options)),
          section(`In flight (${card.inFlightTotal})`, list(card.inFlight.map((row) => renderFlight(row, options)), 'Nothing in flight'),
            card.inFlightMore > 0 && paragraph(`+${card.inFlightMore} more`, 'hvir-meta')),
          section(`Queued (${card.queuedTotal})`, list(card.queued.map((entry) => renderQueued(entry, options)), 'Nothing queued'),
            card.queuedMore > 0 && paragraph(`+${card.queuedMore} more`, 'hvir-meta')),
          section('Active now', list(card.active.map(renderActivity), 'No active agents')),
          section(`In progress (${card.inProgress.length})`, list(card.inProgress.map((bead) => el('li', {},
            button(bead.title, bead.id, () => options.onOpenBead?.(bead.id, bead.store)),
            text(bead.assignee && ` · ${bead.assignee}`, 'hvir-meta'))), 'Nothing in progress')))))
  }

  const navRow = (card, options, withLead = false) => {
    const needs = card.needsCount === 1 ? '1 needs you' : card.needsCount > 1 ? `${card.needsCount} need you` : ''
    const meta = [withLead && card.lead, needs, `${card.milestones.done}/${card.milestones.total} milestones`,
      card.checks.length > 0 && 'record needs a fix', !card.waitsVerified && 'waits unverified'].filter(Boolean).join(' · ')
    const row = el('button', { type: 'button', className: 'projects-nav-row', title: card.id },
      el('span', { className: 'projects-nav-title' }, card.title), chip(card.derivedState), text(meta, 'hvir-meta'))
    row.addEventListener('click', () => options.onOpenProject?.(card.id, card.store))
    return el('li', {}, row)
  }

  const isDone = (card) => card.derivedState === 'done'

  const liveGroups = (model) => model.cards
    .map((group) => ({ ...group, cards: group.cards.filter((card) => !isDone(card)) }))
    .filter((group) => group.cards.length > 0)

  const archive = (model, options, root) => {
    const done = model.cards.flatMap((group) => group.cards).filter(isDone)
    if (done.length === 0) return []
    const node = el('details', { className: 'projects-archive' },
      el('summary', {}, `Done projects (${done.length})`),
      el('ul', {}, ...done.map((card) => navRow(card, options, true))))
    node.open = root.querySelector(':scope > .projects-archive')?.open === true
    return [node]
  }

  const renderNav = (model, root, options = {}) => {
    root.classList.add('projects-nav')
    const overview = button('Open overview', 'All projects on one page', () => options.onOpenOverview?.())
    overview.classList.add('projects-nav-overview')
    root.replaceChildren(
      paragraph(`${model.needsYou.length} need you · ${model.inDelivery.length} answered, waiting on agents`, 'projects-nav-counts'),
      overview,
      ...[stepSection(model, options)].filter(Boolean),
      section('Needs you', ...needsList(model.needsYou.map((ask) => renderAsk(ask, options, true)), options),
        model.cardTextsInvalid && paragraph('Card text record could not be read', 'projects-warning')),
      ...urgentSections(model, options),
      ...liveGroups(model).map((group) => section(group.lead, el('ul', {}, ...group.cards.map((card) => navRow(card, options))))),
      ...archive(model, options, root))
  }

  const renderProjectNeeds = (model, id, root, options = {}) => {
    root.classList.add('projects-dashboard', 'projects-page')
    const back = button('← All projects', 'Back to the overview', () => options.onOpenOverview?.())
    back.classList.add('projects-back')
    const asks = model.needsYou.filter((ask) => ask.metadata?.['gc.project'] === id)
    root.replaceChildren(back, section('Needs you', ...needsList(asks.map((ask) => renderAsk(ask, options)), options)),
      el('section', { className: 'projects-loading' }, paragraph('Loading the rest of this project…', 'hvir-meta')))
  }

  window.projectsRender = Object.freeze({ renderDashboard, renderNav, renderProject, renderProjectNeeds })
})()
