/* global window, document */
window.feedbackView = (() => {
  const { el } = window
  const root = document.getElementById('feedback')
  let selected = new Set()
  let source

  function checkbox(thread) {
    const input = el('input', { type: 'checkbox', checked: selected.has(thread.id), title: 'Include in copied feedback' })
    input.setAttribute('aria-label', `Include the thread at ${thread.path ?? 'unknown location'} in copied feedback`)
    input.addEventListener('change', () => {
      selected = new Set(selected)
      if (input.checked) selected.add(thread.id)
      else selected.delete(thread.id)
      render()
    })
    return input
  }

  async function copy(text, area, status) {
    try {
      await navigator.clipboard.writeText(text)
      status.textContent = 'Copied.'
    } catch {
      area.focus()
      area.select()
      status.textContent = 'Selected the preview; press ⌘C to copy it.'
    }
  }

  function render() {
    if (!source || selected.size === 0) {
      root.hidden = true
      root.replaceChildren()
      return
    }
    const preview = window.feedbackPreview.feedbackPreview(source.pullRequest, source.repo, selected)
    const status = el('span', { className: 'hvir-meta', role: 'status' })
    const area = el('textarea', { className: 'hvir-field feedback-text', readOnly: true, rows: 10, value: preview.ok ? preview.text : '' })
    area.setAttribute('aria-label', 'Exact feedback preview')
    const button = el('button', { className: 'hvir-button', type: 'button', disabled: !preview.ok }, 'Copy feedback')
    button.dataset.variant = 'regular'
    button.addEventListener('click', () => void copy(area.value, area, status))
    const clear = el('button', { className: 'hvir-button', type: 'button' }, 'Clear selection')
    clear.dataset.variant = 'regular'
    clear.addEventListener('click', () => {
      selected = new Set()
      source.onClear()
      render()
    })
    root.hidden = false
    root.replaceChildren(
      el('h3', {}, `Selected feedback · ${selected.size}`),
      el('p', { className: 'hvir-meta' }, 'Labelled as untrusted hosted feedback, ready to paste to an agent.'),
      preview.ok ? area : el('p', { className: 'hvir-meta' }, preview.reason),
      el('div', { className: 'draft-actions' }, button, clear, status),
    )
  }

  function update(pullRequest, repo, onClear) {
    const ids = new Set((pullRequest?.reviewThreads?.nodes ?? []).map((thread) => thread.id))
    selected = new Set([...selected].filter((id) => ids.has(id)))
    source = pullRequest ? { pullRequest, repo, onClear } : undefined
    render()
  }

  function reset() {
    selected = new Set()
    source = undefined
    render()
  }

  return Object.freeze({ checkbox, update, reset })
})()
