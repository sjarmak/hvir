/* global window, document */
window.submitView = (() => {
  const { el } = window
  const page = window.reviewPage
  const { validate, submitReview } = window.reviewSubmit
  const root = document.getElementById('submit')
  const LABELS = {
    COMMENT: 'Comment',
    APPROVE: 'Approve',
    REQUEST_CHANGES: 'Request changes',
  }
  const SAVE_DELAY_MS = 800
  let saveTimer
  let busy = false
  let status = ''

  function context() {
    const { shown, state, headOid } = page.current()
    const pullRequest = shown?.detail?.data?.repository?.pullRequest
    const viewer = shown?.detail?.data?.viewer?.login
    const pending = (pullRequest?.pending?.nodes ?? []).find(
      (node) => node.viewerDidAuthor,
    )
    return {
      shown,
      state,
      headOid,
      pullRequest,
      isAuthor: viewer !== undefined && pullRequest?.author?.login === viewer,
      pending,
      gh: shown?.connectors?.gh === 'supported',
    }
  }

  function eventChoices(current) {
    const events = Object.keys(LABELS)
    return el(
      'div',
      { className: 'event-choices', role: 'radiogroup' },
      ...events.map((event) => {
        const input = el('input', {
          type: 'radio',
          name: 'event',
          value: event,
          checked: current === event,
        })
        input.addEventListener('change', () => {
          page.update({ event })
          page.saveReview()
        })
        return el('label', { className: 'hvir-field' }, input, LABELS[event])
      }),
    )
  }

  function summaryField(summary) {
    const text = el('textarea', {
      className: 'hvir-field',
      rows: 6,
      value: summary,
      placeholder: 'Review summary (Markdown)',
    })
    text.setAttribute('aria-label', 'Review summary')
    text.addEventListener('input', () => {
      page.update({ summary: text.value })
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(page.saveReview, SAVE_DELAY_MS)
    })
    return text
  }

  function draftList(drafts, headOid) {
    if (drafts.length === 0)
      return el('p', { className: 'hvir-meta' }, 'No draft line comments.')
    const byPath = new Map()
    for (const draft of drafts)
      byPath.set(draft.path, [...(byPath.get(draft.path) ?? []), draft])
    return el(
      'div',
      { className: 'draft-list' },
      ...[...byPath].map(([path, list]) => {
        const jump = el(
          'button',
          { className: 'hvir-button link-button', type: 'button' },
          path,
        )
        jump.addEventListener('click', () => page.select(path))
        return el(
          'div',
          { className: 'draft-file' },
          jump,
          ...list.map((draft) =>
            el(
              'div',
              { className: 'draft' },
              el(
                'span',
                { className: 'hvir-meta' },
                `${draft.side === 'LEFT' ? 'old ' : ''}line ${draft.line}`,
                draft.commit && headOid && draft.commit !== headOid
                  ? ' · written on an older commit'
                  : '',
              ),
              window.markdown.render(draft.body),
            ),
          ),
        )
      }),
    )
  }

  const started = new Map()

  async function currentHead(submitted) {
    const { headRefOid } = await window.host.run('gh', submitted.workspace, [
      'pr',
      'view',
      String(submitted.number),
      '-R',
      submitted.repo,
      '--json',
      'headRefOid',
    ])
    return headRefOid
  }

  async function submit() {
    if (busy) return
    const { state, pullRequest, isAuthor, pending } = context()
    const event = isAuthor ? 'COMMENT' : state.event
    const problem = validate({
      event,
      summary: state.summary,
      drafts: state.drafts,
      isAuthor,
      pendingComments: pending?.comments?.totalCount ?? 0,
    })
    if (problem) return setStatus(problem)
    if (!pullRequest?.id) return setStatus('The pull request is still loading.')
    const submitted = page.target()
    busy = true
    setStatus(`Submitting ${LABELS[event].toLowerCase()} review…`)
    const unsaved = []
    try {
      const head = await currentHead(submitted)
      if (!submitted.diffHead || head !== submitted.diffHead)
        throw new Error('New commits arrived since this diff loaded. Wait for the page to refresh, check your line comments, then submit again.')
      const result = await submitReview({
        run: (args) => window.host.run('gh', submitted.workspace, args),
        pull: { id: pullRequest.id, headRefOid: head },
        pendingReviewId: pending?.id ?? started.get(submitted.key),
        drafts: state.drafts,
        event,
        summary: state.summary,
        onStarted: (id) => started.set(submitted.key, id),
        onPosted: (draft) =>
          page.forgetDraft(submitted, draft.id).catch((error) => unsaved.push(error.message)),
      })
      started.delete(submitted.key)
      await Promise.resolve(page.finishSubmit(submitted)).catch((error) => unsaved.push(error.message))
      setStatus(
        [
          `Submitted: ${result.state.toLowerCase().replaceAll('_', ' ')} · ${result.url}`,
          unsaved.length ? `Posted drafts may still show here after a reload (${unsaved[0]}); delete them by hand.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      )
      void window.pullView?.refresh()
    } catch (error) {
      const continuing = started.has(submitted.key)
        ? ' Your pending review on GitHub keeps what was already added; submitting again continues it.'
        : ''
      setStatus(`${error.message}${continuing}`)
    } finally {
      busy = false
      render()
    }
  }

  function setStatus(text) {
    status = text
    render()
  }

  function render() {
    const { state, headOid, isAuthor, pending, gh } = context()
    if (document.activeElement?.closest?.('#submit textarea')) {
      root.querySelector('.submit-status').textContent = status
      return
    }
    const button = el(
      'button',
      { className: 'hvir-button', type: 'button', disabled: busy || !gh },
      busy ? 'Submitting…' : 'Submit review',
    )
    button.dataset.variant = 'regular'
    button.addEventListener('click', () => void submit())
    root.replaceChildren(
      ...[
      el('h2', {}, 'Submit review'),
      isAuthor
        ? el(
            'p',
            { className: 'hvir-meta' },
            'This is your pull request, so the review is a comment.',
          )
        : eventChoices(state.event),
      summaryField(state.summary),
      pending
        ? el(
            'p',
            { className: 'hvir-meta' },
            `You already have a pending review on GitHub with ${pending.comments.totalCount} comments. Submitting sends those too.`,
          )
        : null,
      el('h3', {}, `Line comments · ${state.drafts.length}`),
      draftList(state.drafts, headOid),
      el(
        'div',
        { className: 'submit-actions' },
        button,
        el('span', { className: 'hvir-meta' }, 'Posts to GitHub only when you click.'),
      ),
      el('p', { className: 'hvir-meta submit-status', role: 'status' }, status),
      ].filter(Boolean),
    )
  }

  page.onChange(() => {
    if (!root.hidden && !document.activeElement?.closest?.('#submit textarea')) render()
  })

  return Object.freeze({ render })
})()
