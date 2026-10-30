/* global window, document */
window.reviewPage = (() => {
  const { el } = window
  const store = window.reviewStore
  const review = window.reviewState
  const ui = Object.fromEntries(
    [
      'checklist',
      'progress',
      'store-note',
      'connect-store',
      'brief',
      'file',
      'file-head',
      'file-loose',
      'file-diff',
      'city',
      'submit',
    ].map((id) => [id, document.getElementById(id)]),
  )

  let shown
  let state = { read: {}, summary: '', event: 'COMMENT', drafts: [], skipped: 0 }
  let selected = 'overview'
  let editing
  let largeShown = new Set()
  let listBinding
  const listeners = new Set()
  let setStatus = () => {}
  let cityData = { key: undefined, runs: [], packages: new Map() }

  const cityFindings = () => {
    const [latest] = cityData.runs
    return (latest && cityData.packages.get(latest.id)?.pkg?.findings) || []
  }

  const files = () => shown?.files ?? []
  const threadsTruncated = () =>
    shown?.detail?.data?.repository?.pullRequest?.reviewThreads?.pageInfo?.hasNextPage ===
    true
  const threads = () =>
    shown?.detail?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
  const headOid = () =>
    shown?.detail?.data?.repository?.pullRequest?.headRefOid ?? shown?.pull?.headRefOid

  function persist(write) {
    if (!shown?.store) return
    write(shown.store).catch((error) => setStatus(`Not saved: ${error.message}`))
  }

  const saveReview = () =>
    persist((client) =>
      client.write(
        store.reviewName(shown.repo, shown.number),
        review.savedReview(state, files()),
      ),
    )

  function update(next) {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }

  function setRead(file, read) {
    update(review.withRead(state, file, read))
    saveReview()
    renderChecklist()
  }

  function saveDraft(text) {
    if (text.trim() === '') return
    const { path, side, line, draftId } = editing
    const id = draftId ?? review.newDraftId()
    const previous = state.drafts.find((draft) => draft.id === id)
    const draft = {
      id,
      path,
      side,
      line,
      body: text,
      commit: previous?.commit ?? headOid() ?? '',
    }
    update({ drafts: [...state.drafts.filter((other) => other.id !== id), draft] })
    editing = undefined
    persist((client) =>
      client.write(
        store.draftName(shown.repo, shown.number, id),
        review.savedDraft(draft),
      ),
    )
    renderAll()
  }

  function deleteDraft(draft) {
    update({ drafts: state.drafts.filter((other) => other.id !== draft.id) })
    persist((client) =>
      client.remove(store.draftName(shown.repo, shown.number, draft.id)),
    )
    renderAll()
  }

  const handlers = {
    findingBlock: (finding) => window.cityView.findingBlock(finding),
    onComment(target) {
      editing = { path: selected, ...target, text: '' }
      renderFile()
    },
    onEdit(draft) {
      editing = {
        path: draft.path,
        side: draft.side,
        line: draft.line,
        text: draft.body,
        draftId: draft.id,
      }
      renderFile()
    },
    onDelete: deleteDraft,
    onInput(text) {
      if (editing) editing = { ...editing, text }
    },
    onSave: saveDraft,
    onCancel() {
      editing = undefined
      renderFile()
    },
    onShowLarge() {
      largeShown = new Set(largeShown).add(selected)
      renderFile()
    },
  }

  function select(key) {
    if (editing && editing.path !== key) editing = undefined
    selected = key
    renderAll()
    document.getElementById('pane')?.scrollTo(0, 0)
  }

  function checklistRow(key, title, meta, flags = {}) {
    const row = el(
      'button',
      { type: 'button', className: 'hvir-row check-row', tabIndex: -1, title },
      el(
        'span',
        { className: 'check-mark', 'aria-hidden': 'true' },
        flags.read ? '✓' : (flags.mark ?? ''),
      ),
      el('span', { className: 'check-title' }, title),
      meta ? el('span', { className: 'hvir-meta check-meta' }, meta) : null,
    )
    row.dataset.variant = 'selectable'
    row.dataset.key = key
    row.dataset.read = String(Boolean(flags.read))
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(selected === key))
    return row
  }

  function fileTitle(path) {
    const slash = path.lastIndexOf('/')
    return slash < 0 ? path : `${path.slice(slash + 1)}  ${path.slice(0, slash)}`
  }

  function renderChecklist() {
    listBinding?.dispose()
    const draftCount = state.drafts.length
    const { read, total } = review.progress(state, files())
    ui.progress.textContent = shown?.diffError
      ? `Diff unavailable: ${shown.diffError}`
      : `${read} of ${total} files reviewed`
    const rows = [
      checklistRow('overview', 'Overview', 'checks, reviews, conversation', {
        mark: '◆',
      }),
      ...cityRow(),
      ...files().map((file) => {
        const drafts = state.drafts.filter((draft) => draft.path === file.path).length
        const row = checklistRow(
          file.path,
          fileTitle(file.path),
          [
            `+${file.additions} −${file.deletions}`,
            file.status === 'modified' ? '' : file.status,
            drafts ? `${drafts} draft` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          { read: review.isRead(state, file) },
        )
        row.title = file.path
        return row
      }),
      checklistRow(
        'submit',
        'Submit review',
        draftCount
          ? `${draftCount} draft ${draftCount === 1 ? 'comment' : 'comments'}`
          : '',
        {
          mark: '➤',
        },
      ),
    ]
    ui.checklist.replaceChildren(...rows)
    listBinding = window.hvirUI.bindList(ui.checklist, (row) => {
      if (row.dataset.key !== selected) select(row.dataset.key)
    })
  }

  function fileHead(file) {
    const read = el('input', { type: 'checkbox', checked: review.isRead(state, file) })
    read.addEventListener('change', () => setRead(file, read.checked))
    const next = el(
      'button',
      { className: 'hvir-button', type: 'button' },
      'Reviewed, next file',
    )
    next.dataset.variant = 'regular'
    next.addEventListener('click', () => {
      setRead(file, true)
      select(review.nextUnread(state, files(), file.path)?.path ?? 'submit')
    })
    const renamed =
      file.status === 'renamed' && file.oldPath
        ? `renamed from ${file.oldPath}`
        : file.status === 'modified'
          ? ''
          : file.status
    return [
      el('h2', { className: 'file-path selectable' }, file.path),
      el(
        'p',
        { className: 'hvir-meta' },
        [`+${file.additions} −${file.deletions}`, renamed].filter(Boolean).join(' · '),
      ),
      el(
        'div',
        { className: 'file-actions' },
        el('label', { className: 'hvir-field' }, read, 'Reviewed'),
        next,
      ),
    ]
  }

  function renderFile() {
    const file = files().find((candidate) => candidate.path === selected)
    if (!file) return
    const fileThreads = threads().filter((thread) => thread.path === file.path)
    const fileDrafts = state.drafts.filter((draft) => draft.path === file.path)
    const rendered = window.diffView.render(file, {
      threads: fileThreads,
      drafts: fileDrafts,
      findings: cityFindings().filter((finding) => finding.file === file.path && finding.line),
      editing: editing?.path === file.path ? editing : undefined,
      headOid: headOid(),
      showLarge: largeShown.has(file.path),
      handlers,
    })
    ui['file-head'].replaceChildren(...fileHead(file))
    const loose = [
      ...(threadsTruncated()
        ? [
            el(
              'p',
              { className: 'hvir-meta' },
              'Only the first 100 review threads are shown; open GitHub for the rest.',
            ),
          ]
        : []),
      ...(rendered.loose.length
        ? [
            el(
              'p',
              { className: 'hvir-meta' },
              `${rendered.loose.length} outdated or unplaced review threads`,
            ),
            ...rendered.loose.map(window.diffView.threadBlock),
          ]
        : []),
      ...(rendered.unplacedFindings.length
        ? [
            el('p', { className: 'hvir-meta' }, 'City findings not on a changed line'),
            ...rendered.unplacedFindings.map(window.cityView.findingBlock),
          ]
        : []),
      ...cityFindings()
        .filter((finding) => finding.file === file.path && !finding.line)
        .map(window.cityView.findingBlock),
      ...(rendered.unplaced?.length
        ? [
            el(
              'p',
              { className: 'hvir-meta' },
              'Drafts whose line is no longer in the diff',
            ),
            ...rendered.unplaced,
          ]
        : []),
    ]
    ui['file-loose'].replaceChildren(...loose)
    ui['file-loose'].hidden = loose.length === 0
    ui['file-diff'].replaceChildren(rendered.table)
  }

  function jump(path, line) {
    select(path)
    const row = line ? ui['file-diff'].querySelector(`.line-row[data-new-line="${line}"]`) : undefined
    row?.scrollIntoView({ block: 'center' })
  }

  function renderCity() {
    window.cityView.render(ui.city, cityData, { headOid: headOid(), onJump: jump, onStatus: setStatus })
  }

  const PANES = new Set(['overview', 'submit', 'city'])

  function renderAll() {
    renderChecklist()
    const isFile = !PANES.has(selected)
    ui.brief.hidden = selected !== 'overview'
    ui.file.hidden = !isFile
    ui.submit.hidden = selected !== 'submit'
    ui.city.hidden = selected !== 'city'
    if (isFile) renderFile()
    if (selected === 'submit') window.submitView.render()
    if (selected === 'city') renderCity()
  }

  function setCity(key, data) {
    if (shown?.key !== key) return
    cityData = { key, ...data }
    if (document.activeElement?.tagName === 'TEXTAREA') renderChecklist()
    else renderAll()
  }

  function cityRow() {
    if (cityData.key !== shown?.key) return []
    const found = cityData.followups
    if (!cityData.runs.length && !cityData.error && !found?.followups?.length && !found?.error) return []
    const [latest] = cityData.runs
    const parts = [
      latest ? window.cityReviews.chip([latest]).label : cityData.error ? 'unavailable' : '',
      window.cityFollowups.rowPart(found) ?? '',
    ].filter(Boolean)
    return [checklistRow('city', 'City reviews', parts.join(' · ') || 'no review', { mark: '◎' })]
  }

  function storeNote(available, workspace) {
    ui['store-note'].hidden = available
    ui['connect-store'].hidden = available || workspace.host !== 'local'
    ui['store-note'].textContent = available
      ? ''
      : 'Reviewed files and draft comments are kept only while this tab is open. Connect the review store to keep them.'
  }

  let loadingKey

  async function load({ key, repo, number, workspace, connectors }) {
    const available = connectors[store.CONNECTOR] === 'supported'
    storeNote(available, workspace)
    if (shown?.key === key) {
      shown = { ...shown, connectors }
      return
    }
    loadingKey = key
    const client = available ? store.client(window.host.run, workspace) : undefined
    let entries = new Map()
    let note = ''
    try {
      if (client) entries = await client.list(store.pullPrefix(repo, number))
    } catch (error) {
      note = `Saved review progress could not be read, so changes here are not saved: ${error.message}`
    }
    if (loadingKey !== key) return
    const loaded = review.fromListing(entries, repo, number)
    shown = {
      key,
      repo,
      number,
      workspace,
      connectors,
      store: note ? undefined : client,
      files: [],
    }
    selected = 'overview'
    editing = undefined
    largeShown = new Set()
    state = loaded
    if (note) setStatus(note)
    else if (loaded.skipped)
      setStatus(
        `${loaded.skipped} saved review entries could not be read and were skipped.`,
      )
  }

  function target() {
    const { key, repo, number, workspace, diffHead } = shown
    return {
      key,
      repo,
      number,
      workspace,
      diffHead,
      client: shown.store,
      read: state.read,
      files: files(),
    }
  }

  async function forgetDraft(submitted, id) {
    if (shown?.key === submitted.key)
      update({ drafts: state.drafts.filter((draft) => draft.id !== id) })
    await submitted.client?.remove(store.draftName(submitted.repo, submitted.number, id))
  }

  function finishSubmit(submitted) {
    if (shown?.key === submitted.key) update({ summary: '', event: 'COMMENT' })
    const cleared = { read: submitted.read, summary: '', event: 'COMMENT' }
    return submitted.client?.write(
      store.reviewName(submitted.repo, submitted.number),
      review.savedReview(cleared, submitted.files),
    )
  }

  function show({ key, pull, detail, files: diffFiles, diffError, diffHead }) {
    if (shown?.key !== key) return
    shown = {
      ...shown,
      pull,
      detail,
      files: diffFiles ?? shown.files,
      diffError,
      diffHead,
    }
    if (
      !PANES.has(selected) &&
      !files().some((file) => file.path === selected)
    )
      selected = 'overview'
    const typing = document.activeElement?.tagName === 'TEXTAREA'
    if (typing) renderChecklist()
    else renderAll()
  }

  return Object.freeze({
    load,
    show,
    select,
    setStatusHandler: (handler) => (setStatus = handler),
    current: () => ({ shown, state, headOid: headOid() }),
    update,
    saveReview,
    onChange: (listener) => listeners.add(listener),
    target,
    forgetDraft,
    finishSubmit,
    setCity,
  })
})()
