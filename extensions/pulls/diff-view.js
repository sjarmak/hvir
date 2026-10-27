/* global window */
window.diffView = (() => {
  const { el } = window
  const { commentTarget } = window.diffParse
  const LARGE_LINES = 2500

  const targetKey = (side, line) => `${side}:${line}`

  function threadBlock(thread) {
    const state = [
      thread.isResolved ? 'resolved' : 'open',
      thread.isOutdated ? 'outdated' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const comments = (thread.comments?.nodes ?? []).map((comment) =>
      el(
        'div',
        { className: 'thread-comment' },
        el(
          'span',
          { className: 'hvir-meta' },
          `@${comment.author?.login ?? 'unknown'} · ${window.ago(comment.createdAt)}`,
        ),
        window.markdown.render(comment.body ?? ''),
      ),
    )
    const block = el(
      'div',
      { className: 'thread' },
      el('span', { className: 'hvir-meta' }, state),
      ...comments,
    )
    block.dataset.resolved = String(thread.isResolved)
    return block
  }

  function draftBlock(draft, { headOid, onEdit, onDelete }) {
    const stale = draft.commit && headOid && draft.commit !== headOid
    const edit = el('button', { className: 'hvir-button', type: 'button' }, 'Edit')
    edit.dataset.variant = 'regular'
    edit.addEventListener('click', () => onEdit(draft))
    const remove = el('button', { className: 'hvir-button', type: 'button' }, 'Delete')
    remove.dataset.variant = 'regular'
    remove.addEventListener('click', () => onDelete(draft))
    return el(
      'div',
      { className: 'draft' },
      el(
        'span',
        { className: 'hvir-meta' },
        'Your draft comment',
        stale ? ' · written on an older commit, so its line may have moved' : '',
      ),
      window.markdown.render(draft.body),
      el('div', { className: 'draft-actions' }, edit, remove),
    )
  }

  function editorBlock(editing, { onInput, onSave, onCancel }) {
    const text = el('textarea', {
      className: 'hvir-field',
      rows: 4,
      value: editing.text,
      placeholder: 'Leave a comment',
    })
    text.setAttribute('aria-label', `Comment on line ${editing.line}`)
    text.addEventListener('input', () => onInput(text.value))
    text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        onSave(text.value)
      } else if (event.key === 'Escape') onCancel()
    })
    const save = el(
      'button',
      { className: 'hvir-button', type: 'button' },
      editing.draftId ? 'Update draft' : 'Add draft',
    )
    save.dataset.variant = 'regular'
    save.addEventListener('click', () => onSave(text.value))
    const cancel = el('button', { className: 'hvir-button', type: 'button' }, 'Cancel')
    cancel.dataset.variant = 'regular'
    cancel.addEventListener('click', onCancel)
    const block = el(
      'div',
      { className: 'editor' },
      text,
      el('div', { className: 'draft-actions' }, save, cancel),
    )
    window.setTimeout(() => text.focus(), 0)
    return block
  }

  function extrasRow(blocks) {
    return el('tr', { className: 'extras' }, el('td', { colSpan: 3 }, ...blocks))
  }

  function lineRow(line, { onComment }) {
    const target = commentTarget(line)
    const add = target
      ? el(
          'button',
          {
            className: 'add-comment',
            type: 'button',
            title: `Comment on line ${target.line}`,
          },
          '+',
        )
      : null
    add?.addEventListener('click', () => onComment(target))
    const row = el(
      'tr',
      { className: 'line-row' },
      el(
        'td',
        { className: 'num' },
        line.oldLine === undefined || line.kind === 'add' ? '' : String(line.oldLine),
      ),
      el(
        'td',
        { className: 'num' },
        line.newLine === undefined || line.kind === 'del' ? '' : String(line.newLine),
      ),
      el('td', { className: 'code' }, add, el('span', { className: 'text' }, line.text)),
    )
    row.dataset.kind = line.kind
    return row
  }

  function anchoredThreads(threads) {
    const anchored = new Map()
    const loose = []
    for (const thread of threads) {
      if (thread.isOutdated || !thread.line) {
        loose.push(thread)
        continue
      }
      const key = targetKey(thread.diffSide ?? 'RIGHT', thread.line)
      anchored.set(key, [...(anchored.get(key) ?? []), thread])
    }
    return { anchored, loose }
  }

  function render(file, { threads, drafts, editing, headOid, showLarge, handlers }) {
    const { anchored, loose } = anchoredThreads(threads)
    const draftsAt = new Map()
    for (const draft of drafts) {
      const key = targetKey(draft.side, draft.line)
      draftsAt.set(key, [...(draftsAt.get(key) ?? []), draft])
    }
    const placed = new Set()
    const lineCount = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
    if (file.binary)
      return {
        table: el('p', { className: 'hvir-meta' }, 'Binary file, no text diff.'),
        loose,
      }
    if (file.hunks.length === 0)
      return {
        table: el(
          'p',
          { className: 'hvir-meta' },
          'No changed lines (mode change or rename only).',
        ),
        loose,
      }
    if (lineCount > LARGE_LINES && !showLarge) {
      const button = el(
        'button',
        { className: 'hvir-button', type: 'button' },
        `Show ${lineCount} diff lines`,
      )
      button.dataset.variant = 'regular'
      button.addEventListener('click', handlers.onShowLarge)
      return {
        table: el(
          'div',
          { className: 'large' },
          el('p', { className: 'hvir-meta' }, 'Large diff, hidden until you ask.'),
          button,
        ),
        loose,
      }
    }
    const body = el('tbody')
    for (const hunk of file.hunks) {
      body.append(el('tr', { className: 'hunk' }, el('td', { colSpan: 3 }, hunk.header)))
      for (const line of hunk.lines) {
        body.append(lineRow(line, handlers))
        const target = commentTarget(line)
        if (!target) continue
        const key = targetKey(target.side, target.line)
        if (placed.has(key)) continue
        placed.add(key)
        const leftKey = line.kind === 'context' ? targetKey('LEFT', line.oldLine) : undefined
        if (leftKey) placed.add(leftKey)
        const blocks = [
          ...(anchored.get(key) ?? []).map(threadBlock),
          ...(leftKey ? (anchored.get(leftKey) ?? []).map(threadBlock) : []),
          ...(draftsAt.get(key) ?? [])
            .filter((draft) => draft.id !== editing?.draftId)
            .map((draft) => draftBlock(draft, { headOid, ...handlers })),
          editing && targetKey(editing.side, editing.line) === key
            ? editorBlock(editing, handlers)
            : null,
        ].filter(Boolean)
        if (blocks.length) body.append(extrasRow(blocks))
      }
    }
    const unplaced = drafts.filter(
      (draft) => !placed.has(targetKey(draft.side, draft.line)),
    )
    const unplacedThreads = [...anchored.entries()]
      .filter(([key]) => !placed.has(key))
      .flatMap(([, list]) => list)
    return {
      table: el(
        'table',
        { className: 'diff' },
        el('colgroup', {}, el('col', { className: 'num-col' }), el('col', { className: 'num-col' }), el('col')),
        body,
      ),
      loose: [...loose, ...unplacedThreads],
      unplaced: unplaced.map((draft) => draftBlock(draft, { headOid, ...handlers })),
    }
  }

  return Object.freeze({ render, threadBlock })
})()
